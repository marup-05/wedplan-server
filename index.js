
import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

const client = new MongoClient(
  `mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-44gdk0u-shard-00-00.l06uzuf.mongodb.net:27017,ac-44gdk0u-shard-00-01.l06uzuf.mongodb.net:27017,ac-44gdk0u-shard-00-02.l06uzuf.mongodb.net:27017/?ssl=true&replicaSet=atlas-iuroc7-shard-0&authSource=admin`
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

const countActiveServices = (vendorId, excludeId) =>
  services.countDocuments({
    vendorId,
    status: "Approved",
    isActive: true,
    ...(excludeId && { _id: { $ne: new ObjectId(excludeId) } }),
  });

const validId = (id) => ObjectId.isValid(id);

// root api
app.get("/", (req, res) => res.send("WedPlan is planning!"));

// users api (testing only)
app.get("/users", async (req, res) => {
  res.send(await users.find({}).toArray());
});

// public services api
app.get("/services", async (req, res) => {
  res.send(await services.find({ status: "Approved", isActive: true }).toArray());
});

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
  const { vendorId, serviceName, category, description, price, location, images } = req.body;

  if (
    !validId(vendorId) || !serviceName?.trim() || !category ||
    !description?.trim() || !location?.trim() ||
    !Array.isArray(images) || !images.length ||
    !Number.isFinite(Number(price)) || Number(price) <= 0
  ) {
    return res.status(400).send({ message: "Please provide valid service details and images" });
  }

  const vendor = await getVendor(vendorId);
  if (!vendor) return res.status(404).send({ message: "Vendor not found" });

  if (
    (vendor.subscriptionPlan || "Free") !== "Premium" &&
    await countActiveServices(vendorId) >= 3
  ) {
    return res.status(403).send({
      message: "Free plan allows only 3 active services. Upgrade to Premium.",
    });
  }

  const result = await services.insertOne({
    vendorId, serviceName, category, description,
    price: Number(price), location, images,
    status: "Pending", isActive: true, createdAt: new Date(),
  });

  res.send({
    message: "Service submitted. Waiting for admin approval.",
    insertedId: result.insertedId,
  });
});

// update service api
app.patch("/services/:id", async (req, res) => {
  const { id } = req.params;
  const { vendorId, serviceName, category, description, price, location, images } = req.body;

  if (
    !validId(id) || !validId(vendorId) ||
    !serviceName?.trim() || !category || !description?.trim() ||
    !location?.trim() || !Array.isArray(images) || !images.length ||
    !Number.isFinite(Number(price)) || Number(price) <= 0
  ) {
    return res.status(400).send({ message: "Invalid service details or ID" });
  }

  const result = await services.updateOne(
    { _id: new ObjectId(id), vendorId },
    { $set: { serviceName, category, description, price: Number(price), location, images } }
  );

  if (!result.matchedCount)
    return res.status(404).send({ message: "Service not found" });

  res.send({ message: "Service updated successfully" });
});

// service availability api
app.patch("/services/:id/availability", async (req, res) => {
  const { id } = req.params;
  const { vendorId, isActive } = req.body;

  if (!validId(id) || !validId(vendorId) || typeof isActive !== "boolean")
    return res.status(400).send({ message: "Invalid service ID or availability" });

  const service = await services.findOne({ _id: new ObjectId(id), vendorId });
  if (!service) return res.status(404).send({ message: "Service not found" });

  if (isActive && service.status === "Approved") {
    const vendor = await getVendor(vendorId);

    if (
      (vendor?.subscriptionPlan || "Free") !== "Premium" &&
      await countActiveServices(vendorId, id) >= 3
    ) {
      return res.status(403).send({
        message: "Free plan allows only 3 active services. Upgrade to Premium.",
      });
    }
  }

  await services.updateOne(
    { _id: new ObjectId(id), vendorId },
    { $set: { isActive } }
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
    _id: new ObjectId(id), vendorId,
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
    totalServices, activeServices, pendingRequests, acceptedBookings,
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

  const result = await bookings.find({ vendorId }).sort({ createdAt: -1 }).toArray();

  const details = await Promise.all(result.map(async (booking) => {
    const service = validId(booking.serviceId)
      ? await services.findOne({ _id: new ObjectId(booking.serviceId) })
      : null;

    const customer = validId(booking.customerId)
      ? await users.findOne(
          { _id: new ObjectId(booking.customerId) },
          { projection: { name: 1, email: 1, image: 1 } }
        )
      : null;

    return { ...booking, service, customer };
  }));

  res.send(details);
});

// vendor accept or reject booking api
app.patch("/vendor/:vendorId/bookings/:bookingId/status", async (req, res) => {
  const { vendorId, bookingId } = req.params;
  const { status } = req.body;

  if (!validId(vendorId) || !validId(bookingId) ||
      !["Accepted", "Rejected"].includes(status)) {
    return res.status(400).send({ message: "Invalid ID or booking status" });
  }

  if (!(await getVendor(vendorId)))
    return res.status(404).send({ message: "Vendor not found" });

  const result = await bookings.updateOne(
    { _id: new ObjectId(bookingId), vendorId, status: "Pending" },
    { $set: { status } }
  );

  if (!result.matchedCount)
    return res.status(404).send({ message: "Booking not found or no longer Pending" });

  res.send({ message: `Booking ${status.toLowerCase()} successfully` });
});

app.listen(PORT, () => console.log(`WedPlan is running on port ${PORT}`));

export default app;
