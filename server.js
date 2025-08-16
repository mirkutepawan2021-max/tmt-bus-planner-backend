const express = require('express');
const mongoose = require('mongoose');
const BusRoute = require('./models/BusRoute');
const cors = require('cors');
require('dotenv').config();

// Import our schedule calculation utilities
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

// PUT: Update an existing route
app.put('/api/bus-routes/:id', async (req, res) => {
    try {
        const route = await BusRoute.findById(req.params.id);
        if (!route) {
            console.warn(`Route ID ${req.params.id} not found for update.`);
            return res.status(404).json({ message: 'Route not found' });
        }

        Object.assign(route, req.body);
        
        const updatedRoute = await route.save();
        res.json(updatedRoute);
    } catch (err) {
        console.error(`Error updating route ${req.params.id}:`, err);
        res.status(400).json({ message: err.message });
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

// NEW API ENDPOINT: Generate Schedule for a Route
app.get('/api/bus-routes/:id/schedule', async (req, res) => {
    console.log(`[SERVER] Received request for schedule for route ID: ${req.params.id}`);
    try {
        const route = await BusRoute.findById(req.params.id);
        if (!route) {
            console.warn(`[SERVER] Route ID ${req.params.id} not found for schedule generation.`);
            return res.status(404).json({ message: 'Cannot find route' });
        }

        console.log(`[SERVER] Raw Route fetched: ${JSON.stringify(route.toObject(), null, 2)}`);

        // Create a cleaned and prepared route object for the scheduler
        const cleanedRoute = {
            ...route.toObject(),
            leg1: { ...route.leg1.toObject(), kilometers: Number(route.leg1.kilometers), timePerKm: Number(route.leg1.timePerKm) },
            leg2: { ...route.leg2.toObject(), kilometers: Number(route.leg2.kilometers), timePerKm: Number(route.leg2.timePerKm) },
            busesAssigned: Number(route.busesAssigned),
            serviceStartTime: route.serviceStartTime,
            dutyDurationHours: Number(route.dutyDurationHours),
            numberOfShifts: Number(route.numberOfShifts), // Ensure this is converted to Number
            depotConnections: {
                timeFromDepotToStart: Number(route.depotConnections?.timeFromDepotToStart || 0),
                timeFromDepotToEnd: Number(route.depotConnections?.timeFromDepotToEnd || 0),
                timeFromStartToDepot: Number(route.depotConnections?.timeFromStartToDepot || 0),
                timeFromEndToDepot: Number(route.depotConnections?.timeFromEndToDepot || 0)
            },
            crewDutyRules: {
                ...route.crewDutyRules.toObject(),
                hasBreak: route.crewDutyRules?.hasBreak,
                breakDuration: Number(route.crewDutyRules?.breakDuration),
                breakWindowStart: Number(route.crewDutyRules?.breakWindowStart),
                breakWindowEnd: Number(route.crewDutyRules?.breakWindowEnd),
                breakLayoverDuration: Number(route.crewDutyRules?.breakLayoverDuration)
            },
            timeAdjustmentRules: route.timeAdjustmentRules.map(rule => ({
                startTime: rule.startTime,
                endTime: rule.endTime,
                timeAdjustment: Number(rule.timeAdjustment)
            }))
        };
        if (!cleanedRoute.timeAdjustmentRules || cleanedRoute.timeAdjustmentRules.length === 0) {
            cleanedRoute.timeAdjustmentRules = [];
        }

        console.log(`[SERVER] Cleaned route for scheduler: ${JSON.stringify(cleanedRoute, null, 2)}`);
        // --- DEBUG LOG START ---
        console.log(`[SERVER DEBUG] numberOfShifts being passed to generateFullRouteSchedule: ${cleanedRoute.numberOfShifts}`);
        // --- DEBUG LOG END ---

        const { schedules, warnings } = generateFullRouteSchedule(cleanedRoute);

        console.log(`[SERVER] Schedule generated: ${JSON.stringify(schedules, null, 2)}`);
        console.log(`[SERVER] Scheduling warnings: ${JSON.stringify(warnings, null, 2)}`);

        res.json({ schedules, warnings });

    } catch (err) {
        console.error("[SERVER] FATAL ERROR during schedule generation:", err);
        res.status(500).json({ message: `Failed to generate schedule: ${err.message}`, stack: err.stack });
    }
});


// --- Start Server ---
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server is running on http://localhost:${port}`));
