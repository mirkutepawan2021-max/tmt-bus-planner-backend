const express = require('express');
const mongoose = require('mongoose');
const BusRoute = require('./models/BusRoute');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors()); // It's okay to keep this simple for local development
app.use(express.json());

// --- Database Connection ---
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
    console.error('FATAL ERROR: MONGO_URI is not defined.');
    process.exit(1);
}
mongoose.connect(mongoURI)
  .then(() => console.log('MongoDB connected.'))
  .catch(err => console.log(err));

// --- API Routes (These are all correct) ---

// GET: Fetch all routes
app.get('/api/bus-routes', async (req, res) => {
    try {
        const routes = await BusRoute.find().sort({ createdAt: -1 });
        res.json(routes);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET: Fetch a single route
app.get('/api/bus-routes/:id', async (req, res) => {
    try {
        const route = await BusRoute.findById(req.params.id);
        if (!route) return res.status(404).json({ message: 'Cannot find route' });
        res.json(route);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST: Create a new route
app.post('/api/bus-routes', async (req, res) => {
    const busRoute = new BusRoute(req.body);
    try {
        const newBusRoute = await busRoute.save();
        res.status(201).json(newBusRoute);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

// PUT: Update an existing route
app.put('/api/bus-routes/:id', async (req, res) => {
    try {
        const updatedRoute = await BusRoute.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(updatedRoute);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

// DELETE: Remove a route
app.delete('/api/bus-routes/:id', async (req, res) => {
    try {
        await BusRoute.findByIdAndDelete(req.params.id);
        res.json({ message: 'Deleted Bus Route' });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// --- Start Server ---
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server is running on http://localhost:${port}`));
