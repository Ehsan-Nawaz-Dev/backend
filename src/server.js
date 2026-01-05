import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import { connectDB } from "./config/db.js";
import apiRouter from "./routes/index.js";
import { whatsappService } from "./services/whatsappService.js";

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Database connection middleware for serverless
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    res.status(500).json({ error: "Database connection failed" });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "whatflow-backend" });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "WhatFlow Backend API",
    status: "running",
    version: "1.0.0"
  });
});

// API routes
app.use("/api", apiRouter);

// Export app for serverless
export { app };

// Only run server if not in serverless environment
if (process.env.VERCEL !== "1") {
  const PORT = process.env.PORT || 5000;
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_APP_URL || "http://localhost:5173",
      methods: ["GET", "POST"],
    },
  });

  // Socket.IO connection handling
  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Join room for specific shop
    socket.on("join", (shopDomain) => {
      socket.join(shopDomain);
      console.log(`Client ${socket.id} joined room: ${shopDomain}`);
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  // Set Socket.IO instance in WhatsApp service
  whatsappService.setSocketIO(io);

  // Start server after DB connect
  connectDB()
    .then(() => {
      httpServer.listen(PORT, () => {
        console.log(`WhatFlow backend running on port ${PORT}`);
        console.log(`Socket.IO server ready`);
      });
    })
    .catch((err) => {
      console.error("Failed to start server", err);
      process.exit(1);
    });
} else {
  // In serverless environment, we still want to trigger the connection
  connectDB().catch(err => console.error("Initial DB connection failed in serverless mode", err));
}
