import { Router } from "express";
import { Lead } from "../models/Lead.js";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required" });
    }

    const lead = await Lead.create({ name, email, message });
    res.status(201).json(lead);
  } catch (err) {
    console.error("Error creating lead", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
