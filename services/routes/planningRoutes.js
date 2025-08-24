const express = require('express');
const { authenticateToken, authorizeRoles } = require('../auth/middleware');
const { planRoutes, planPreview } = require('./routePlanningController');

const router = express.Router();

router.post('/plan-routes', authenticateToken, authorizeRoles(['admin']), planRoutes);

router.post('/plan-preview', authenticateToken, authorizeRoles(['admin']), planPreview);

module.exports = router;