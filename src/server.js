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
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_APP_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "whatflow-backend" });
});

// API routes
app.use("/api", apiRouter);

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
