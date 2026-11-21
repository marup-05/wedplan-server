import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const PORT = process.env.PORT || 5000;

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

// reusable helpers

const getVendor = (id) =>
  users.findOne({ _id: new ObjectId(id), role: "vendor" });

const getAdmin = (id) =>
  users.findOne({ _id: new ObjectId(id), role: "admin" });

const countActiveServices = (vendorId, excludeId) =>
  services.countDocuments({
    vendorId,
    status: "Approved",
    isActive: true,
    ...(excludeId && { _id: { $ne: new ObjectId(excludeId) } }),
  });

const validId = (id) => ObjectId.isValid(id);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// root api

app.get("/", (req, res) => res.send("WedPlan is planning!"));

// ==================== PUBLIC SERVICES APIs ====================

// all approved and active services

app.get("/services", async (req, res) => {
  res.send(
    await services.find({ status: "Approved", isActive: true }).toArray(),
  );
});

// single service details api

app.get("/services/:id", async (req, res) => {
  const { id } = req.params;

  if (!validId(id)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }

  const service = await services.findOne({
    _id: new ObjectId(id),
    status: "Approved",
    isActive: true,
  });

  if (!service) {
    return res.status(404).send({ message: "Service not found" });
  }

  res.send(service);
});

// ==================== BOOKING APIs ====================

// customer creates booking request

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

  if (Number.isNaN(Date.parse(eventDate))) {
    return res.status(400).send({ message: "Invalid event date" });
  }

  if (new Date(eventDate) < new Date(new Date().toDateString())) {
    return res.status(400).send({
      message: "Event date cannot be in the past",
    });
  }

  const customer = await users.findOne({
    _id: new ObjectId(customerId),
    role: "customer",
  });

  if (!customer) {
    return res.status(404).send({ message: "Customer not found" });
  }

  const service = await services.findOne({
    _id: new ObjectId(serviceId),
    status: "Approved",
    isActive: true,
  });

  if (!service) {
    return res.status(404).send({ message: "Service not available" });
  }

  if (service.vendorId !== vendorId) {
    return res.status(400).send({ message: "Invalid vendor ID" });
  }

  if (customerId === vendorId) {
    return res.status(400).send({
      message: "You cannot book your own service",
    });
  }

  const existingBooking = await bookings.findOne({
    serviceId,
    customerId,
    eventDate,
    status: { $in: ["Pending", "Accepted"] },
  });

  if (existingBooking) {
    return res.status(409).send({
      message: "You already have an active booking for this service and date",
    });
  }

  const booking = {
    serviceId,
    vendorId,
    customerId,
    eventDate,
    eventLocation: eventLocation.trim(),
    message: message?.trim() || "",
    status: "Pending",
    createdAt: new Date(),
  };

  const result = await bookings.insertOne(booking);

  res.status(201).send({
    message: "Booking request created successfully",
    bookingId: result.insertedId,
  });
});

// ==================== VENDOR APIs ====================

// vendor subscription api

app.get("/vendor/:vendorId/subscription", async (req, res) => {
  const { vendorId } = req.params;

  if (!validId(vendorId))
    return res.status(400).send({ message: "Invalid vendor ID" });

  const vendor = await getVendor(vendorId);

  if (!vendor) return res.status(404).send({ message: "Vendor not found" });

  const plan = vendor.subscriptionPlan || "Free";

  res.send({
    plan,
    serviceLimit: plan === "Premium" ? "Unlimited" : 3,
    canUpgrade: plan !== "Premium",
  });
});

// vendor own services api

app.get("/vendor/:vendorId/services", async (req, res) => {
  const { vendorId } = req.params;

  if (!validId(vendorId))
    return res.status(400).send({ message: "Invalid vendor ID" });

  if (!(await getVendor(vendorId)))
    return res.status(404).send({ message: "Vendor not found" });

  res.send(await services.find({ vendorId }).sort({ createdAt: -1 }).toArray());
});

// add service api

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
  ) {
    return res
      .status(400)
      .send({ message: "Please provide valid service details and images" });
  }

  const vendor = await getVendor(vendorId);

  if (!vendor) return res.status(404).send({ message: "Vendor not found" });

  if (
    (vendor.subscriptionPlan || "Free") !== "Premium" &&
    (await countActiveServices(vendorId)) >= 3
  ) {
    return res.status(403).send({
      message: "Free plan allows only 3 active services. Upgrade to Premium.",
    });
  }

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

// update service api

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
  ) {
    return res.status(400).send({ message: "Invalid service details or ID" });
  }

  const result = await services.updateOne(
    { _id: new ObjectId(id), vendorId },
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

// service availability api

app.patch("/services/:id/availability", async (req, res) => {
  const { id } = req.params;
  const { vendorId, isActive } = req.body;

  if (!validId(id) || !validId(vendorId) || typeof isActive !== "boolean") {
    return res
      .status(400)
      .send({ message: "Invalid service ID or availability" });
  }

  const service = await services.findOne({
    _id: new ObjectId(id),
    vendorId,
  });

  if (!service) return res.status(404).send({ message: "Service not found" });

  if (isActive && service.status === "Approved") {
    const vendor = await getVendor(vendorId);

    if (
      (vendor?.subscriptionPlan || "Free") !== "Premium" &&
      (await countActiveServices(vendorId, id)) >= 3
    ) {
      return res.status(403).send({
        message: "Free plan allows only 3 active services. Upgrade to Premium.",
      });
    }
  }

  await services.updateOne(
    { _id: new ObjectId(id), vendorId },
    { $set: { isActive } },
  );

  res.send({ message: "Availability updated successfully" });
});

// delete service api

app.delete("/services/:id", async (req, res) => {
  const { id } = req.params;
  const { vendorId } = req.body;

  if (!validId(id) || !validId(vendorId))
    return res.status(400).send({ message: "Invalid service or vendor ID" });

  const result = await services.deleteOne({
    _id: new ObjectId(id),
    vendorId,
  });

  if (!result.deletedCount)
    return res.status(404).send({ message: "Service not found" });

  res.send({ message: "Service deleted successfully" });
});

// vendor dashboard api

app.get("/vendor/:vendorId/dashboard", async (req, res) => {
  const { vendorId } = req.params;

  if (!validId(vendorId))
    return res.status(400).send({ message: "Invalid vendor ID" });

  const vendor = await getVendor(vendorId);

  if (!vendor) return res.status(404).send({ message: "Vendor not found" });

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

// vendor booking requests api

app.get("/vendor/:vendorId/bookings", async (req, res) => {
  const { vendorId } = req.params;

  if (!validId(vendorId))
    return res.status(400).send({ message: "Invalid vendor ID" });

  if (!(await getVendor(vendorId)))
    return res.status(404).send({ message: "Vendor not found" });

  const result = await bookings
    .find({ vendorId })
    .sort({ createdAt: -1 })
    .toArray();

  const details = await Promise.all(
    result.map(async (booking) => {
      const service = validId(booking.serviceId)
        ? await services.findOne({ _id: new ObjectId(booking.serviceId) })
        : null;

      const customer = validId(booking.customerId)
        ? await users.findOne(
            { _id: new ObjectId(booking.customerId) },
            { projection: { name: 1, email: 1, image: 1 } },
          )
        : null;

      return { ...booking, service, customer };
    }),
  );

  res.send(details);
});

// vendor accept or reject booking api

app.patch("/vendor/:vendorId/bookings/:bookingId/status", async (req, res) => {
  const { vendorId, bookingId } = req.params;
  const { status } = req.body;

  if (
    !validId(vendorId) ||
    !validId(bookingId) ||
    !["Accepted", "Rejected"].includes(status)
  ) {
    return res.status(400).send({ message: "Invalid ID or booking status" });
  }

  if (!(await getVendor(vendorId)))
    return res.status(404).send({ message: "Vendor not found" });

  const result = await bookings.updateOne(
    { _id: new ObjectId(bookingId), vendorId, status: "Pending" },
    { $set: { status } },
  );

  if (!result.matchedCount)
    return res
      .status(404)
      .send({ message: "Booking not found or no longer Pending" });

  res.send({ message: `Booking ${status.toLowerCase()} successfully` });
});

// ==================== ADMIN APIs ====================

// admin dashboard overview api

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

// admin users list, search and role filter api

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
    const searchRegex = new RegExp(escapeRegex(search.trim()), "i");
    query.$or = [{ name: searchRegex }, { email: searchRegex }];
  }

  const result = await users
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
    .toArray();

  res.send(result);
});

// admin single user details api

app.get("/admin/:adminId/users/:userId", async (req, res) => {
  const { adminId, userId } = req.params;

  if (!validId(adminId) || !validId(userId))
    return res.status(400).send({ message: "Invalid admin or user ID" });

  if (!(await getAdmin(adminId)))
    return res.status(403).send({ message: "Admin access required" });

  const user = await users.findOne(
    { _id: new ObjectId(userId) },
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

// admin block or unblock user api

app.patch("/admin/:adminId/users/:userId/status", async (req, res) => {
  const { adminId, userId } = req.params;
  const { isBlocked } = req.body;

  if (!validId(adminId) || !validId(userId) || typeof isBlocked !== "boolean") {
    return res.status(400).send({ message: "Invalid ID or block status" });
  }

  if (!(await getAdmin(adminId)))
    return res.status(403).send({ message: "Admin access required" });

  if (adminId === userId && isBlocked)
    return res
      .status(400)
      .send({ message: "You cannot block your own admin account" });

  const result = await users.updateOne(
    {
      _id: new ObjectId(userId),
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

// admin all services, search and filter api

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
    const searchRegex = new RegExp(escapeRegex(search.trim()), "i");

    query.$or = [
      { serviceName: searchRegex },
      { category: searchRegex },
      { location: searchRegex },
      { description: searchRegex },
    ];
  }

  const result = await services.find(query).sort({ createdAt: -1 }).toArray();

  const details = await Promise.all(
    result.map(async (service) => {
      const vendor = validId(service.vendorId)
        ? await users.findOne(
            { _id: new ObjectId(service.vendorId) },
            {
              projection: {
                name: 1,
                email: 1,
                image: 1,
                businessName: 1,
                subscriptionPlan: 1,
              },
            },
          )
        : null;

      return { ...service, vendor };
    }),
  );

  res.send(details);
});

// admin approve, reject or change service availability api

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
  ) {
    return res.status(400).send({ message: "Invalid service status" });
  }

  if (isActive !== undefined && typeof isActive !== "boolean")
    return res.status(400).send({ message: "Invalid availability status" });

  if (status === undefined && isActive === undefined)
    return res.status(400).send({ message: "Provide status or isActive" });

  const service = await services.findOne({
    _id: new ObjectId(serviceId),
  });

  if (!service) return res.status(404).send({ message: "Service not found" });

  if (
    isActive !== undefined &&
    service.status !== "Approved" &&
    status === undefined
  )
    return res.status(400).send({
      message: "Only approved services can change availability",
    });

  let updatedStatus = status ?? service.status;

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
      return res.status(404).send({ message: "Service vendor not found" });

    if (
      (vendor.subscriptionPlan || "Free") !== "Premium" &&
      (await countActiveServices(service.vendorId, serviceId)) >= 3
    ) {
      return res.status(403).send({
        message:
          "This vendor has reached the Free plan limit of 3 active services.",
      });
    }
  }

  await services.updateOne(
    { _id: new ObjectId(serviceId) },
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

// admin delete inappropriate service api

app.delete("/admin/:adminId/services/:serviceId", async (req, res) => {
  const { adminId, serviceId } = req.params;

  if (!validId(adminId) || !validId(serviceId))
    return res.status(400).send({ message: "Invalid admin or service ID" });

  if (!(await getAdmin(adminId)))
    return res.status(403).send({ message: "Admin access required" });

  const result = await services.deleteOne({
    _id: new ObjectId(serviceId),
  });

  if (!result.deletedCount)
    return res.status(404).send({ message: "Service not found" });

  res.send({ message: "Service deleted successfully" });
});

// admin transactions list api (read only)

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
            { _id: new ObjectId(transaction.vendorId) },
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

// server

app.listen(PORT, () => console.log(`WedPlan is running on port ${PORT}`));

export default app;
