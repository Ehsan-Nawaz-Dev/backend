import mongoose from "mongoose";

export const connectDB = async () => {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/whatflow";

  try {
    await mongoose.connect(uri, {
      autoIndex: true,
    });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error", err);
    throw err;
  }
};
