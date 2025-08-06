const express = require('express');
const router = express.Router();
const { supabase } = require('../../shared/database/supabase');
const { createServiceLogger } = require('../../shared/logger');
const { authenticateToken, authorizeRoles } = require('../auth/middleware');
const Joi = require('joi');

const logger = createServiceLogger('buses-service');

// Validation schema
const busSchema = Joi.object({
  bus_number: Joi.string().min(1).max(20).required(),
  capacity: Joi.number().integer().min(10).max(100).required(),
  status: Joi.string().valid('active', 'maintenance', 'retired').default('active')
});

// Health check
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'buses',
    message: 'Buses service is running' 
  });
});

// Get all buses
router.get('/', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = supabase
      .from('buses')
      .select('*')
      .order('bus_number');

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch buses', { error });
      return res.status(500).json({ error: 'Failed to fetch buses' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get buses error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get bus by ID
router.get('/:id', authenticateToken, authorizeRoles(['admin', 'dispatcher', 'driver']), async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('buses')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Bus not found' });
      }
      logger.error('Failed to fetch bus', { error });
      return res.status(500).json({ error: 'Failed to fetch bus' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get bus error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new bus (Admin only)
router.post('/', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { error: validationError, value } = busSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    // Check if bus number already exists
    const { data: existingBus } = await supabase
      .from('buses')
      .select('id')
      .eq('bus_number', value.bus_number)
      .single();

    if (existingBus) {
      return res.status(400).json({ error: 'Bus number already exists' });
    }

    const { data, error } = await supabase
      .from('buses')
      .insert(value)
      .select()
      .single();

    if (error) {
      logger.error('Failed to create bus', { error });
      return res.status(500).json({ error: 'Failed to create bus' });
    }

    logger.info('Bus created', { busId: data.id, userId: req.user.id });

    res.status(201).json({ data });
  } catch (error) {
    logger.error('Create bus error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update bus (Admin only)
router.put('/:id', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};

    // Validate and pick allowed fields
    const allowedFields = ['bus_number', 'capacity', 'status'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Check if bus number already exists (if updating bus_number)
    if (updates.bus_number) {
      const { data: existingBus } = await supabase
        .from('buses')
        .select('id')
        .eq('bus_number', updates.bus_number)
        .neq('id', id)
        .single();

      if (existingBus) {
        return res.status(400).json({ error: 'Bus number already exists' });
      }
    }

    const { data, error } = await supabase
      .from('buses')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Bus not found' });
      }
      logger.error('Failed to update bus', { error });
      return res.status(500).json({ error: 'Failed to update bus' });
    }

    logger.info('Bus updated', { busId: id, userId: req.user.id });

    res.json({ data });
  } catch (error) {
    logger.error('Update bus error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete bus (Admin only)
router.delete('/:id', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    // Check if bus has active schedules
    const { data: schedules } = await supabase
      .from('schedules')
      .select('id')
      .eq('bus_id', id)
      .eq('status', 'in_progress')
      .limit(1);

    if (schedules && schedules.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete bus with active schedules' 
      });
    }

    const { error } = await supabase
      .from('buses')
      .delete()
      .eq('id', id);

    if (error) {
      logger.error('Failed to delete bus', { error });
      return res.status(500).json({ error: 'Failed to delete bus' });
    }

    logger.info('Bus deleted', { busId: id, userId: req.user.id });

    res.json({ message: 'Bus deleted successfully' });
  } catch (error) {
    logger.error('Delete bus error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;