// server.js

const express = require('express');
const mongoose = require('mongoose');
const BusRoute = require('./models/BusRoute');
const cors = require('cors');
require('dotenv').config();
console.log('Mongo URI:', process.env.MONGO_URI);
const { generateFullRouteSchedule } = require('./utils/scheduleCalculator');

const app = express();
app.use(cors());
app.use(express.json());

// --- Database Connection ---
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
    console.error('FATAL ERROR: MONGO_URI is not defined. Please set it in your .env file.');
    process.exit(1);
}
mongoose.connect(mongoURI)
  .then(() => console.log('MongoDB connected.'))
  .catch(err => {
      console.error('MongoDB connection error:', err);
      process.exit(1);
  });

// --- API Routes ---

// GET: Fetch all routes
app.get('/api/bus-routes', async (req, res) => {
    try {
        const routes = await BusRoute.find().sort({ createdAt: -1 });
        res.json(routes);
    } catch (err) {
        console.error('Error fetching all routes:', err);
        res.status(500).json({ message: err.message });
    }
});

// GET: Fetch a single route
app.get('/api/bus-routes/:id', async (req, res) => {
    try {
        const route = await BusRoute.findById(req.params.id);
        if (!route) {
            console.warn(`Route ID ${req.params.id} not found.`);
            return res.status(404).json({ message: 'Cannot find route' });
        }
        res.json(route);
    } catch (err) {
        console.error(`Error fetching route ${req.params.id}:`, err);
        res.status(500).json({ message: err.message });
    }
});

// POST: Create a new route
app.post('/api/bus-routes', async (req, res) => {
    const busRoute = new BusRoute(req.body);
    try {
        const newBusRoute = await busRoute.save();
        res.status(201).json(newBusRoute);
    } catch (err) {
        console.error('Error creating new route:', err);
        res.status(400).json({ message: err.message });
    }
});

// --- FIXED PUT ROUTE ---
// PUT: Update an existing route
app.put('/api/bus-routes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;
        console.log(updateData);
        // Use findByIdAndUpdate for a more robust and direct update.
        // The { new: true } option ensures the updated document is returned.
        const updatedRoute = await BusRoute.findByIdAndUpdate(
            id, 
            { $set: updateData }, // Use $set to ensure all fields, including nested ones, are updated
            { new: true, runValidators: true }
        );

        if (!updatedRoute) {
            console.warn(`Route ID ${id} not found for update.`);
            return res.status(404).json({ message: 'Route not found' });
        }
        res.json(updatedRoute);
    } catch (err) {
        console.error(`Error updating route ${req.params.id}:`, err);
        // Add more detailed error logging
        if (err.name === 'ValidationError') {
            return res.status(400).json({ message: 'Validation Error', errors: err.errors });
        }
        res.status(500).json({ message: err.message });
    }
});

// DELETE: Remove a route
app.delete('/api/bus-routes/:id', async (req, res) => {
    try {
        await BusRoute.findByIdAndDelete(req.params.id);
        res.json({ message: 'Deleted Bus Route' });
    } catch (err) {
        console.error(`Error deleting route ${req.params.id}:`, err);
        res.status(500).json({ message: err.message });
    }
});

// GET: Generate Schedule for a Route
app.get('/api/bus-routes/:id/schedule', async (req, res) => {
    try {
        const route = await BusRoute.findById(req.params.id);
        if (!route) {
            return res.status(404).json({ message: 'Cannot find route' });
        }
       
        const cleanedRoute = {
            ...route.toObject(),
            leg1: { ...route.leg1.toObject(), kilometers: Number(route.leg1.kilometers), timePerKm: Number(route.leg1.timePerKm) },
            leg2: { ...route.leg2.toObject(), kilometers: Number(route.leg2.kilometers), timePerKm: Number(route.leg2.timePerKm) },
            busesAssigned: Number(route.busesAssigned),
            dutyDurationHours: Number(route.dutyDurationHours),
            numberOfShifts: Number(route.numberOfShifts),
            depotConnections: {
                timeFromDepotToStart: Number(route.depotConnections?.timeFromDepotToStart || 0),
                timeFromDepotToEnd: Number(route.depotConnections?.timeFromDepotToEnd || 0),
                timeFromStartToDepot: Number(route.depotConnections?.timeFromStartToDepot || 0),
                timeFromEndToDepot: Number(route.depotConnections?.timeFromEndToDepot || 0)
            },
            crewDutyRules: {
                ...(route.crewDutyRules ? route.crewDutyRules.toObject() : {}),
                breakDuration: Number(route.crewDutyRules?.breakDuration),
                breakWindowStart: Number(route.crewDutyRules?.breakWindowStart),
                breakWindowEnd: Number(route.crewDutyRules?.breakWindowEnd),
                breakLayoverDuration: Number(route.crewDutyRules?.breakLayoverDuration)
            },
            timeAdjustmentRules: (route.timeAdjustmentRules || []).map(rule => ({
                ...rule.toObject(),
                timeAdjustment: Number(rule.timeAdjustment)
            })),
            frequency: {
                type: route.frequency?.type || 'standard',
                dynamicMinutes: Number(route.frequency?.dynamicMinutes || 0)
            }
        };
        
        const { schedules, warnings } = generateFullRouteSchedule(cleanedRoute);
        res.json({ schedules, warnings });

    } catch (err) {
        console.error("[SERVER] FATAL ERROR during schedule generation:", err);
        res.status(500).json({ message: `Failed to generate schedule: ${err.message}`, stack: err.stack });
    }
});


// --- Start Server ---
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server is running on http://localhost:${port}`));
