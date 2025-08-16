const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const TimeAdjustmentRuleSchema = new Schema({
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    timeAdjustment: { type: Number, required: true }
}, { _id: false });

const BusRouteSchema = new Schema({
    routeNumber: { type: String, required: true, trim: true },
    routeName: { type: String, required: true, trim: true },
    fromTerminal: { type: String, required: true },
    toTerminal: { type: String, required: true },
    leg1: { directionName: { type: String }, kilometers: { type: Number, required: true }, timePerKm: { type: Number, required: true } },
    leg2: { directionName: { type: String }, kilometers: { type: Number, required: true }, timePerKm: { type: Number, required: true } },
    depotName: { type: String, trim: true },
    isTurnoutFromDepot: { type: Boolean, default: false },
    depotConnections: {
        timeFromDepotToStart: { type: Number },
        timeFromDepotToEnd: { type: Number },
        timeFromStartToDepot: { type: Number },
        timeFromEndToDepot: { type: Number }
    },
    busesAssigned: { type: Number, required: true },
    // REVERTED: Back to single serviceStartTime and dutyDurationHours
    serviceStartTime: { type: String, required: true },
    dutyDurationHours: { type: Number, required: true, default: 8 }, 
    numberOfShifts: { type: Number, required: true, default: 1 }, // NEW FIELD
    timeAdjustmentRules: [TimeAdjustmentRuleSchema],
    crewDutyRules: {
        hasBreak: { type: Boolean, default: true },
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
        this.depotName = undefined;
        this.depotConnections = undefined;
    }
    next();
});

module.exports = mongoose.model('BusRoute', BusRouteSchema);
