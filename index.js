
import express from "express";
import cors from "cors";
import "dotenv/config";
import Stripe from "stripe";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const PORT = process.env.PORT || 5000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());
app.use(cors());

const client = new MongoClient(
  `mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-44gdk0u-shard-00-00.l06uzuf.mongodb.net:27017,ac-44gdk0u-shard-00-01.l06uzuf.mongodb.net:27017,ac-44gdk0u-shard-00-02.l06uzuf.mongodb.net:27017/?ssl=true&replicaSet=atlas-iuroc7-shard-0&authSource=admin`,
);

await client.connect();
console.log("Connected to MongoDB!");

const database = client.db("wedPlan");
const users = database.collection("user");
const services = database.collection("services");
const bookings = database.collection("bookings");
const transactions = database.collection("transactions");

// Helpers
const validId = (id) => ObjectId.isValid(id);
const objectId = (id) => new ObjectId(id);

const getUser = (id, role) =>
  users.findOne({
    _id: objectId(id),
    role,
    isBlocked: { $ne: true },
  });

const getVendor = (id) => getUser(id, "vendor");
const getAdmin = (id) => getUser(id, "admin");
const getCustomer = (id) => getUser(id, "customer");

const countActiveServices = (vendorId, excludeId) =>
  services.countDocuments({
    vendorId,
    status: "Approved",
    isActive: true,
    ...(excludeId && { _id: { $ne: objectId(excludeId) } }),
  });

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const userProjection = {
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  businessName: 1,
  subscriptionPlan: 1,
  isBlocked: 1,
};

const getBookingDetails = async (booking) => {
  const [service, vendor] = await Promise.all([
    validId(booking.serviceId)
      ? services.findOne({ _id: objectId(booking.serviceId) })
      : null,
    validId(booking.vendorId)
      ? users.findOne(
          { _id: objectId(booking.vendorId) },
          { projection: userProjection },
        )
      : null,
  ]);

  return { ...booking, service, vendor };
};

// Root
app.get("/", (req, res) => res.send("WedPlan is planning!"));

// ==================== STRIPE PAYMENT VERIFY ====================

app.post("/payments/checkout-verify", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId)
    return res.status(400).send({ message: "Session ID required" });

  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    session.mode !== "payment"
  ) {
    return res.status(400).send({ message: "Payment not completed" });
  }

  const vendorId = session.metadata?.vendorId;

  if (!validId(vendorId))
    return res.status(400).send({ message: "Invalid vendor ID" });

  const vendor = await getVendor(vendorId);

  if (!vendor)
    return res.status(404).send({ message: "Vendor not found" });

  const existing = await transactions.findOne({
    stripeSessionId: sessionId,
  });

  if (existing)
    return res.send({ message: "Payment already verified" });

  await users.updateOne(
    { _id: objectId(vendorId) },
    { $set: { subscriptionPlan: "Premium" } },
  );

  await transactions.insertOne({
    vendorId,
    stripeSessionId: sessionId,
    paymentIntentId: session.payment_intent,
    amount: session.amount_total / 100,
    currency: session.currency,
    status: "Paid",
    plan: "Premium",
    createdAt: new Date(),
  });

  res.send({ message: "Premium activated successfully" });
});

// ==================== PUBLIC SERVICES ====================

// All approved and active services
app.get("/services", async (req, res) => {
  const allServices = await services
    .find({ status: "Approved", isActive: true })
    .toArray();

  const vendorIds = [
    ...new Set(allServices.map((s) => s.vendorId).filter(validId)),
  ];

  const blockedVendors = await users
    .find(
      {
        _id: { $in: vendorIds.map(objectId) },
        isBlocked: true,
      },
      { projection: { _id: 1 } },
    )
    .toArray();

  const blockedIds = new Set(blockedVendors.map((v) => v._id.toString()));

  res.send(allServices.filter((s) => !blockedIds.has(s.vendorId)));
});

// Single service details
app.get("/services/:id", async (req, res) => {
  const { id } = req.params;

  if (!validId(id))
    return res.status(400).send({ message: "Invalid service ID" });

  const service = await services.findOne({
    _id: objectId(id),
    status: "Approved",
    isActive: true,
  });

  if (
    !service ||
    !validId(service.vendorId) ||
    !(await getVendor(service.vendorId))
  )
    return res.status(404).send({ message: "Service not found" });

  res.send(service);
});

// ==================== BOOKING CREATE ====================

app.post("/bookings", async (req, res) => {
  const { serviceId, vendorId, customerId, eventDate, eventLocation, message } =
    req.body;

  if (
    !validId(serviceId) ||
    !validId(vendorId) ||
    !validId(customerId) ||
    !eventDate ||
    !eventLocation?.trim()
  ) {
    return res.status(400).send({
      message: "Please provide valid booking information",
    });
  }

  if (Number.isNaN(Date.parse(eventDate)))
    return res.status(400).send({ message: "Invalid event date" });

  if (new Date(eventDate) < new Date(new Date().toDateString()))
    return res.status(400).send({
      message: "Event date cannot be in the past",
    });

  const [customer, vendor] = await Promise.all([
    getCustomer(customerId),
    getVendor(vendorId),
  ]);

  if (!customer)
    return res.status(403).send({
      message: "Customer account is blocked or unavailable",
    });

  if (!vendor)
    return res.status(403).send({
      message: "Vendor account is blocked or unavailable",
    });

  if (customerId === vendorId)
    return res.status(400).send({
      message: "You cannot book your own service",
    });

  const service = await services.findOne({
    _id: objectId(serviceId),
    status: "Approved",
    isActive: true,
    vendorId,
  });

  if (!service)
    return res.status(404).send({ message: "Service not available" });

  const existingBooking = await bookings.findOne({
    serviceId,
    customerId,
    eventDate,
    status: { $in: ["Pending", "Accepted"] },
  });

  if (existingBooking)
    return res.status(409).send({
      message: "You already have an active booking for this service and date",
    });

  const result = await bookings.insertOne({
    serviceId,
    vendorId,
    customerId,
    eventDate,
    eventLocation: eventLocation.trim(),
    message: message?.trim() || "",
    status: "Pending",
    createdAt: new Date(),
  });

  res.status(201).send({
    message: "Booking request created successfully",
    bookingId: result.insertedId,
  });
});

// ==================== CUSTOMER APIs ====================

// Customer dashboard overview
app.get("/customer/:customerId/dashboard", async (req, res) => {
  const { customerId } = req.params;

  if (!validId(customerId))
    return res.status(400).send({ message: "Invalid customer ID" });

  if (!(await getCustomer(customerId)))
    return res.status(403).send({
      message: "Customer account is blocked or unavailable",
    });

  const [totalBookings, pendingBookings, acceptedBookings, rejectedBookings] =
    await Promise.all([
      bookings.countDocuments({ customerId }),
      bookings.countDocuments({ customerId, status: "Pending" }),
      bookings.countDocuments({ customerId, status: "Accepted" }),
      bookings.countDocuments({ customerId, status: "Rejected" }),
    ]);

  res.send({
    totalBookings,
    pendingBookings,
    acceptedBookings,
    rejectedBookings,
  });
});

// Customer all bookings
app.get("/customer/:customerId/bookings", async (req, res) => {
  const { customerId } = req.params;

  if (!validId(customerId))
    return res.status(400).send({ message: "Invalid customer ID" });

  if (!(await getCustomer(customerId)))
    return res.status(403).send({
      message: "Customer account is blocked or unavailable",
    });

  const result = await bookings
    .find({ customerId })
    .sort({ createdAt: -1 })
    .toArray();

  const details = await Promise.all(result.map(getBookingDetails));

  res.send(details);
});

// Customer single booking details
app.get("/customer/:customerId/bookings/:bookingId", async (req, res) => {
  const { customerId, bookingId } = req.params;

  if (!validId(customerId) || !validId(bookingId))
    return res.status(400).send({ message: "Invalid customer or booking ID" });

  if (!(await getCustomer(customerId)))
    return res.status(403).send({
      message: "Customer account is blocked or unavailable",
    });

  const booking = await bookings.findOne({
    _id: objectId(bookingId),
    customerId,
  });

  if (!booking) return res.status(404).send({ message: "Booking not found" });

  res.send(await getBookingDetails(booking));
});

// Customer cancel pending booking
app.patch(
  "/customer/:customerId/bookings/:bookingId/cancel",
  async (req, res) => {
    const { customerId, bookingId } = req.params;

    if (!validId(customerId) || !validId(bookingId))
      return res.status(400).send({
        message: "Invalid customer or booking ID",
      });

    if (!(await getCustomer(customerId)))
      return res.status(403).send({
        message: "Customer account is blocked or unavailable",
      });

    const result = await bookings.updateOne(
      {
        _id: objectId(bookingId),
        customerId,
        status: "Pending",
      },
      { $set: { status: "Cancelled", updatedAt: new Date() } },
    );

    if (!result.matchedCount) {
      const booking = await bookings.findOne({
        _id: objectId(bookingId),
        customerId,
      });

      if (!booking)
        return res.status(404).send({ message: "Booking not found" });

      return res.status(400).send({
        message: `You cannot cancel a ${booking.status.toLowerCase()} booking`,
      });
    }

    res.send({ message: "Booking cancelled successfully" });
  },
);

// ==================== VENDOR APIs ====================

// Vendor subscription
app.get("/vendor/:vendorId/subscription", async (req, res) => {
  const { vendorId } = req.params;

  if (!validId(vendorId))
    return res.status(400).send({ message: "Invalid vendor ID" });

  const vendor = await getVendor(vendorId);

  if (!vendor)
    return res.status(403).send({
      message: "Vendor account is blocked or unavailable",
    });

  const plan = vendor.subscriptionPlan || "Free";

  res.send({
    plan,
    serviceLimit: plan === "Premium" ? "Unlimited" : 3,
    canUpgrade: plan !== "Premium",
  });
});

// Vendor own services
app.get("/vendor/:vendorId/services", async (req, res) => {
  const { vendorId } = req.params;

  if (!validId(vendorId))
    return res.status(400).send({ message: "Invalid vendor ID" });

  if (!(await getVendor(vendorId)))
    return res.status(403).send({
      message: "Vendor account is blocked or unavailable",
    });

  res.send(await services.find({ vendorId }).sort({ createdAt: -1 }).toArray());
});

// Add service
app.post("/services", async (req, res) => {
  const {
    vendorId,
    serviceName,
    category,
    description,
    price,
    location,
    images,
  } = req.body;

  if (
    !validId(vendorId) ||
    !serviceName?.trim() ||
    !category ||
    !description?.trim() ||
    !location?.trim() ||
    !Array.isArray(images) ||
    !images.length ||
    !Number.isFinite(Number(price)) ||
    Number(price) <= 0
  )
    return res.status(400).send({
      message: "Please provide valid service details and images",
    });

  const vendor = await getVendor(vendorId);

  if (!vendor)
    return res.status(403).send({
      message: "Vendor account is blocked or unavailable",
    });

  if (
    (vendor.subscriptionPlan || "Free") !== "Premium" &&
    (await countActiveServices(vendorId)) >= 3
  )
    return res.status(403).send({
      message: "Free plan allows only 3 active services. Upgrade to Premium.",
    });

  const result = await services.insertOne({
    vendorId,
    serviceName,
    category,
    description,
    price: Number(price),
    location,
    images,
    status: "Pending",
    isActive: true,
    createdAt: new Date(),
  });

  res.send({
    message: "Service submitted. Waiting for admin approval.",
    insertedId: result.insertedId,
  });
});

// Update service
app.patch("/services/:id", async (req, res) => {
  const { id } = req.params;
  const {
    vendorId,
    serviceName,
    category,
    description,
    price,
    location,
    images,
  } = req.body;

  if (
    !validId(id) ||
    !validId(vendorId) ||
    !serviceName?.trim() ||
    !category ||
    !description?.trim() ||
    !location?.trim() ||
    !Array.isArray(images) ||
    !images.length ||
    !Number.isFinite(Number(price)) ||
    Number(price) <= 0
  )
    return res.status(400).send({ message: "Invalid service details or ID" });

  if (!(await getVendor(vendorId)))
    return res.status(403).send({
      message: "Vendor account is blocked or unavailable",
    });

  const result = await services.updateOne(
    { _id: objectId(id), vendorId },
    {
      $set: {
        serviceName,
        category,
        description,
        price: Number(price),
        location,
        images,
      },
    },
  );

  if (!result.matchedCount)
    return res.status(404).send({ message: "Service not found" });

  res.send({ message: "Service updated successfully" });
});

// Service availability
app.patch("/services/:id/availability", async (req, res) => {
  const { id } = req.params;
  const { vendorId, isActive } = req.body;

  if (!validId(id) || !validId(vendorId) || typeof isActive !== "boolean")
    return res.status(400).send({
      message: "Invalid service ID or availability",
    });

  const vendor = await getVendor(vendorId);

  if (!vendor)
    return res.status(403).send({
      message: "Vendor account is blocked or unavailable",
    });

  const service = await services.findOne({
    _id: objectId(id),
    vendorId,
  });

  if (!service) return res.status(404).send({ message: "Service not found" });

  if (
    isActive &&
    service.status === "Approved" &&
    (vendor.subscriptionPlan || "Free") !== "Premium" &&
    (await countActiveServices(vendorId, id)) >= 3
  )
    return res.status(403).send({
      message: "Free plan allows only 3 active services. Upgrade to Premium.",
    });

  await services.updateOne(
    { _id: objectId(id), vendorId },
    { $set: { isActive } },
  );

  res.send({ message: "Availability updated successfully" });
});

// Delete service
app.delete("/services/:id", async (req, res) => {
  const { id } = req.params;
  const { vendorId } = req.body;

  if (!validId(id) || !validId(vendorId))
    return res.status(400).send({ message: "Invalid service or vendor ID" });

  if (!(await getVendor(vendorId)))
    return res.status(403).send({
      message: "Vendor account is blocked or unavailable",
    });

  const result = await services.deleteOne({
    _id: objectId(id),
    vendorId,
  });

  if (!result.deletedCount)
    return res.status(404).send({ message: "Service not found" });

  res.send({ message: "Service deleted successfully" });
});

// Vendor dashboard
app.get("/vendor/:vendorId/dashboard", async (req, res) => {
  const { vendorId } = req.params;

  if (!validId(vendorId))
    return res.status(400).send({ message: "Invalid vendor ID" });

  const vendor = await getVendor(vendorId);

  if (!vendor)
    return res.status(403).send({
      message: "Vendor account is blocked or unavailable",
    });

  const [totalServices, activeServices, pendingRequests, acceptedBookings] =
    await Promise.all([
      services.countDocuments({ vendorId }),
      countActiveServices(vendorId),
      bookings.countDocuments({ vendorId, status: "Pending" }),
      bookings.countDocuments({ vendorId, status: "Accepted" }),
    ]);

  res.send({
    totalServices,
    activeServices,
    pendingRequests,
    acceptedBookings,
    subscriptionPlan: vendor.subscriptionPlan || "Free",
  });
});

// Vendor bookings
app.get("/vendor/:vendorId/bookings", async (req, res) => {
  const { vendorId } = req.params;

  if (!validId(vendorId))
    return res.status(400).send({ message: "Invalid vendor ID" });

  if (!(await getVendor(vendorId)))
    return res.status(403).send({
      message: "Vendor account is blocked or unavailable",
    });

  const result = await bookings
    .find({ vendorId })
    .sort({ createdAt: -1 })
    .toArray();

  const details = await Promise.all(
    result.map(async (booking) => {
      const [service, customer] = await Promise.all([
        validId(booking.serviceId)
          ? services.findOne({ _id: objectId(booking.serviceId) })
          : null,
        validId(booking.customerId)
          ? users.findOne(
              { _id: objectId(booking.customerId) },
              { projection: { name: 1, email: 1, image: 1 } },
            )
          : null,
      ]);

      return { ...booking, service, customer };
    }),
  );

  res.send(details);
});

// Vendor accept or reject booking
app.patch("/vendor/:vendorId/bookings/:bookingId/status", async (req, res) => {
  const { vendorId, bookingId } = req.params;
  const { status } = req.body;

  if (
    !validId(vendorId) ||
    !validId(bookingId) ||
    !["Accepted", "Rejected"].includes(status)
  )
    return res.status(400).send({ message: "Invalid ID or booking status" });

  if (!(await getVendor(vendorId)))
    return res.status(403).send({
      message: "Vendor account is blocked or unavailable",
    });

  const result = await bookings.updateOne(
    { _id: objectId(bookingId), vendorId, status: "Pending" },
    { $set: { status } },
  );

  if (!result.matchedCount)
    return res.status(404).send({
      message: "Booking not found or no longer Pending",
    });

  res.send({ message: `Booking ${status.toLowerCase()} successfully` });
});

// ==================== ADMIN APIs ====================

// Admin dashboard
app.get("/admin/:adminId/dashboard", async (req, res) => {
  const { adminId } = req.params;

  if (!validId(adminId))
    return res.status(400).send({ message: "Invalid admin ID" });

  if (!(await getAdmin(adminId)))
    return res.status(403).send({ message: "Admin access required" });

  const [
    totalUsers,
    totalVendors,
    totalCustomers,
    totalServices,
    pendingServices,
    totalTransactions,
  ] = await Promise.all([
    users.countDocuments({}),
    users.countDocuments({ role: "vendor" }),
    users.countDocuments({ role: "customer" }),
    services.countDocuments({}),
    services.countDocuments({ status: "Pending" }),
    transactions.countDocuments({}),
  ]);

  res.send({
    totalUsers,
    totalVendors,
    totalCustomers,
    totalServices,
    pendingServices,
    totalTransactions,
  });
});

// Admin users list, search and filter
app.get("/admin/:adminId/users", async (req, res) => {
  const { adminId } = req.params;
  const { search = "", role = "" } = req.query;

  if (!validId(adminId))
    return res.status(400).send({ message: "Invalid admin ID" });

  if (!(await getAdmin(adminId)))
    return res.status(403).send({ message: "Admin access required" });

  if (role && !["admin", "vendor", "customer"].includes(role))
    return res.status(400).send({ message: "Invalid user role" });

  const query = {};
  if (role) query.role = role;

  if (search.trim()) {
    const regex = new RegExp(escapeRegex(search.trim()), "i");
    query.$or = [{ name: regex }, { email: regex }];
  }

  res.send(
    await users
      .find(query, {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          isBlocked: 1,
          emailVerified: 1,
          createdAt: 1,
          businessName: 1,
        },
      })
      .sort({ createdAt: -1 })
      .toArray(),
  );
});

// Admin single user details
app.get("/admin/:adminId/users/:userId", async (req, res) => {
  const { adminId, userId } = req.params;

  if (!validId(adminId) || !validId(userId))
    return res.status(400).send({ message: "Invalid admin or user ID" });

  if (!(await getAdmin(adminId)))
    return res.status(403).send({ message: "Admin access required" });

  const user = await users.findOne(
    { _id: objectId(userId) },
    {
      projection: {
        name: 1,
        email: 1,
        image: 1,
        role: 1,
        isBlocked: 1,
        emailVerified: 1,
        createdAt: 1,
        businessName: 1,
        subscriptionPlan: 1,
        subscriptionExpiresAt: 1,
      },
    },
  );

  if (!user) return res.status(404).send({ message: "User not found" });

  res.send(user);
});

// Admin block or unblock user
app.patch("/admin/:adminId/users/:userId/status", async (req, res) => {
  const { adminId, userId } = req.params;
  const { isBlocked } = req.body;

  if (!validId(adminId) || !validId(userId) || typeof isBlocked !== "boolean")
    return res.status(400).send({ message: "Invalid ID or block status" });

  if (!(await getAdmin(adminId)))
    return res.status(403).send({ message: "Admin access required" });

  if (adminId === userId && isBlocked)
    return res.status(400).send({
      message: "You cannot block your own admin account",
    });

  const result = await users.updateOne(
    {
      _id: objectId(userId),
      role: { $in: ["admin", "vendor", "customer"] },
    },
    { $set: { isBlocked, updatedAt: new Date() } },
  );

  if (!result.matchedCount)
    return res.status(404).send({ message: "User not found" });

  res.send({
    message: isBlocked
      ? "User blocked successfully"
      : "User unblocked successfully",
  });
});

// Admin services list, search and filter
app.get("/admin/:adminId/services", async (req, res) => {
  const { adminId } = req.params;
  const { search = "", status = "", isActive = "" } = req.query;

  if (!validId(adminId))
    return res.status(400).send({ message: "Invalid admin ID" });

  if (!(await getAdmin(adminId)))
    return res.status(403).send({ message: "Admin access required" });

  if (status && !["Pending", "Approved", "Rejected"].includes(status))
    return res.status(400).send({ message: "Invalid service status" });

  if (isActive && !["true", "false"].includes(isActive))
    return res.status(400).send({ message: "Invalid availability filter" });

  const query = {};
  if (status) query.status = status;
  if (isActive) query.isActive = isActive === "true";

  if (search.trim()) {
    const regex = new RegExp(escapeRegex(search.trim()), "i");
    query.$or = [
      { serviceName: regex },
      { category: regex },
      { location: regex },
      { description: regex },
    ];
  }

  const result = await services.find(query).sort({ createdAt: -1 }).toArray();

  const details = await Promise.all(
    result.map(async (service) => {
      const vendor = validId(service.vendorId)
        ? await users.findOne(
            { _id: objectId(service.vendorId) },
            {
              projection: {
                name: 1,
                email: 1,
                image: 1,
                businessName: 1,
                subscriptionPlan: 1,
                isBlocked: 1,
              },
            },
          )
        : null;

      return { ...service, vendor };
    }),
  );

  res.send(details);
});

// Admin approve, reject or change availability
app.patch("/admin/:adminId/services/:serviceId/status", async (req, res) => {
  const { adminId, serviceId } = req.params;
  const { status, isActive } = req.body;

  if (!validId(adminId) || !validId(serviceId))
    return res.status(400).send({ message: "Invalid admin or service ID" });

  if (!(await getAdmin(adminId)))
    return res.status(403).send({ message: "Admin access required" });

  if (
    status !== undefined &&
    !["Pending", "Approved", "Rejected"].includes(status)
  )
    return res.status(400).send({ message: "Invalid service status" });

  if (isActive !== undefined && typeof isActive !== "boolean")
    return res.status(400).send({ message: "Invalid availability status" });

  if (status === undefined && isActive === undefined)
    return res.status(400).send({ message: "Provide status or isActive" });

  const service = await services.findOne({ _id: objectId(serviceId) });

  if (!service) return res.status(404).send({ message: "Service not found" });

  if (
    isActive !== undefined &&
    service.status !== "Approved" &&
    status === undefined
  )
    return res.status(400).send({
      message: "Only approved services can change availability",
    });

  const updatedStatus = status ?? service.status;
  let updatedActive =
    isActive !== undefined
      ? isActive
      : status !== undefined
        ? status === "Approved"
        : service.isActive;

  if (updatedStatus !== "Approved") updatedActive = false;

  if (updatedStatus === "Approved" && updatedActive) {
    if (!validId(service.vendorId))
      return res.status(400).send({ message: "Invalid service vendor ID" });

    const vendor = await getVendor(service.vendorId);

    if (!vendor)
      return res.status(403).send({
        message: "Service vendor is blocked or unavailable",
      });

    if (
      (vendor.subscriptionPlan || "Free") !== "Premium" &&
      (await countActiveServices(service.vendorId, serviceId)) >= 3
    )
      return res.status(403).send({
        message:
          "This vendor has reached the Free plan limit of 3 active services.",
      });
  }

  await services.updateOne(
    { _id: objectId(serviceId) },
    {
      $set: {
        status: updatedStatus,
        isActive: updatedActive,
        updatedAt: new Date(),
      },
    },
  );

  res.send({
    message: "Service status updated successfully",
    status: updatedStatus,
    isActive: updatedActive,
  });
});

// Admin delete service
app.delete("/admin/:adminId/services/:serviceId", async (req, res) => {
  const { adminId, serviceId } = req.params;

  if (!validId(adminId) || !validId(serviceId))
    return res.status(400).send({ message: "Invalid admin or service ID" });

  if (!(await getAdmin(adminId)))
    return res.status(403).send({ message: "Admin access required" });

  const result = await services.deleteOne({ _id: objectId(serviceId) });

  if (!result.deletedCount)
    return res.status(404).send({ message: "Service not found" });

  res.send({ message: "Service deleted successfully" });
});

// Admin transactions
app.get("/admin/:adminId/transactions", async (req, res) => {
  const { adminId } = req.params;

  if (!validId(adminId))
    return res.status(400).send({ message: "Invalid admin ID" });

  if (!(await getAdmin(adminId)))
    return res.status(403).send({ message: "Admin access required" });

  const result = await transactions.find({}).sort({ createdAt: -1 }).toArray();

  const details = await Promise.all(
    result.map(async (transaction) => {
      const vendor = validId(transaction.vendorId)
        ? await users.findOne(
            { _id: objectId(transaction.vendorId) },
            {
              projection: {
                name: 1,
                email: 1,
                image: 1,
                businessName: 1,
              },
            },
          )
        : null;

      return { ...transaction, vendor };
    }),
  );

  res.send(details);
});

  
app.listen(PORT, () => console.log(`WedPlan is running on port ${PORT}`));

export default app;
