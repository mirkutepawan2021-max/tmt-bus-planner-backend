const mongoose = require('mongoose');

// Define nested schemas for organization
const legSchema = new mongoose.Schema({
    kilometers: { type: String, default: '' },
    timePerKm: { type: String, default: '5' }
}, { _id: false });

const depotConnectionsSchema = new mongoose.Schema({
    timeFromDepotToStart: { type: String, default: '' },
    timeFromDepotToEnd: { type: String, default: '' },
    timeFromStartToDepot: { type: String, default: '' },
    timeFromEndToDepot: { type: String, default: '' }
}, { _id: false });

const timeAdjustmentRuleSchema = new mongoose.Schema({
    startTime: { type: String, default: '00:00' },
    endTime: { type: String, default: '00:00' },
    timeAdjustment: { type: Number, default: 0 }
}, { _id: false });

const crewDutyRulesSchema = new mongoose.Schema({
    hasBreak: { type: Boolean, default: true },
    breakLocation: { type: String, default: '' },
    breakDuration: { type: String, default: '30' },
    breakWindowStart: { type: String, default: '150' },
    breakWindowEnd: { type: String, default: '240' },
    breakLayoverDuration: { type: String, default: '0' }
}, { _id: false });

const frequencySchema = new mongoose.Schema({
    type: { type: String, enum: ['standard', 'dynamic'], default: 'standard' },
    dynamicMinutes: { type: String, default: '' }
}, { _id: false });

// --- NEW SCHEMA FOR GENERAL SHIFT ---
const generalShiftSchema = new mongoose.Schema({
    numberOfBuses: { type: String, default: '' },
    startTime: { type: String, default: '' }
}, { _id: false });


// --- MAIN ROUTE SCHEMA ---
const busRouteSchema = new mongoose.Schema({
    // Your existing fields (unchanged)
    routeNumber: { type: String, required: true, trim: true },
    routeName: { type: String, required: true, trim: true },
    fromTerminal: { type: String, required: true, trim: true },
    toTerminal: { type: String, required: true, trim: true },
    leg1: legSchema,
    leg2: legSchema,
    depotName: { type: String, trim: true, default: '' },
    isTurnoutFromDepot: { type: Boolean, default: false },
    depotConnections: depotConnectionsSchema,
    busesAssigned: { type: String, required: true },
    serviceStartTime: { type: String, required: true },
    dutyDurationHours: { type: String, default: '8' },
    numberOfShifts: { type: String, default: '2' },
    hasDynamicSecondShift: { type: Boolean, default: false },
    secondShiftStartTime: { type: String, default: '' },
    frequency: frequencySchema,
    timeAdjustmentRules: [timeAdjustmentRuleSchema],
    crewDutyRules: crewDutyRulesSchema,
    
    // --- NEW FIELDS ADDED FOR GENERAL SHIFT FUNCTIONALITY ---
    includeGeneralShift: {
        type: Boolean,
        default: false
    },
    generalShift: generalShiftSchema,

}, { timestamps: true });

module.exports = mongoose.model('BusRoute', busRouteSchema);
