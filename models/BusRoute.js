const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const TimeAdjustmentRuleSchema = new Schema({
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    timeAdjustment: { type: Number, required: true }
}, { _id: false });

// REMOVED: The WaypointSchema is no longer needed and has been deleted.

const BusRouteSchema = new Schema({
    routeNumber: { type: String, required: true, trim: true },
    routeName: { type: String, required: true, trim: true },
    fromTerminal: { type: String, required: true },
    toTerminal: { type: String, required: true },
    leg1: { directionName: { type: String }, kilometers: { type: Number, required: true }, timePerKm: { type: Number, required: true } },
    leg2: { directionName: { type: String }, kilometers: { type: Number, required: true }, timePerKm: { type: Number, required: true } },
    isTurnoutFromDepot: { type: Boolean, default: false },
    depotConnections: {
        timeFromDepotToStart: { type: Number },
        timeFromDepotToEnd: { type: Number },
        timeFromStartToDepot: { type: Number },
        timeFromEndToDepot: { type: Number }
    },
    busesAssigned: { type: Number, required: true },
    // REMOVED: recoveryTimeAtFromTerminal and recoveryTimeAtToTerminal are gone.
    serviceStartTime: { type: String, required: true },
    serviceEndTime: { type: String, required: true },
    timeAdjustmentRules: [TimeAdjustmentRuleSchema],
    // REMOVED: The waypoints array is gone.
    crewDutyRules: {
        breakLocation: { type: String },
        breakDuration: { type: Number, default: 30 },
        breakWindowStart: { type: Number, default: 150 },
        breakWindowEnd: { type: Number, default: 240 },
        breakLayoverDuration: { type: Number, default: 0 }
    }
}, {
    timestamps: true
});

BusRouteSchema.pre('save', function(next) {
    if (this.isModified('fromTerminal') || this.isModified('toTerminal') || this.isNew) {
        this.leg1.directionName = `${this.fromTerminal} to ${this.toTerminal}`;
        this.leg2.directionName = `${this.toTerminal} to ${this.fromTerminal}`;
    }
    if (!this.isTurnoutFromDepot) {
        this.depotConnections = undefined;
    }
    next();
});

module.exports = mongoose.model('BusRoute', BusRouteSchema);
