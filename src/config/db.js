import mongoose from "mongoose";

let isConnected = false;

export const connectDB = async () => {
  if (isConnected) {
    console.log("Using existing MongoDB connection");
    return;
  }

  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/whatflow";

  try {
    const db = await mongoose.connect(uri, {
      autoIndex: true,
    });
    isConnected = db.connections[0].readyState === 1;
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error", err);
    throw err;
  }
};
