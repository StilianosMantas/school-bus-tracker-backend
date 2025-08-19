const express = require('express');
const router = express.Router();
const { supabase } = require('../../shared/database/supabase');
const { createServiceLogger } = require('../../shared/logger');
const { authenticateToken, authorizeRoles } = require('../auth/middleware');
const multer = require('multer');
const csv = require('csv-parse');
const xlsx = require('xlsx');
const fs = require('fs').promises;
const path = require('path');
const Joi = require('joi');
const geocodingService = require('../geocoding/geocoding-service');

const logger = createServiceLogger('student-data-service');

// Days of week mapping
const DAYS_OF_WEEK = [
  { value: 1, label: 'Δευτέρα', short: 'Δευ' },
  { value: 2, label: 'Τρίτη', short: 'Τρι' },
  { value: 3, label: 'Τετάρτη', short: 'Τετ' },
  { value: 4, label: 'Πέμπτη', short: 'Πεμ' },
  { value: 5, label: 'Παρασκευή', short: 'Παρ' }
];

// Configure multer for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only CSV and Excel files are allowed.'));
    }
  }
});

// Student validation schema
const studentSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  grade: Joi.string().max(20).required(),
  medical_info: Joi.string().max(500).allow('', null),
  emergency_contact: Joi.string().max(100).allow('', null),
  emergency_phone: Joi.string().pattern(/^(\+30)?[0-9]{10}$/).allow('', null),
  external_student_id: Joi.string().max(100).allow('', null).optional(),
  parent_email: Joi.string().email().required(),
  parent_name: Joi.string().min(2).max(100).required(),
  parent_phone: Joi.string().pattern(/^(\+30)?[0-9]{10}$/).required(),
  stop_id: Joi.string().uuid().allow(null).optional(),
  is_active: Joi.boolean().default(true)
});

// Student address validation schema
const studentAddressSchema = Joi.object({
  address_type: Joi.string().valid('primary', 'secondary', 'weekend', 'alternate', 'emergency').required(),
  address_name: Joi.string().max(100).allow('', null).optional(),
  street_name: Joi.string().max(200).required(),
  street_number: Joi.string().max(20).required(),
  postal_code: Joi.string().max(10).allow('', null).optional(),
  city: Joi.string().max(100).default('Αθήνα'),
  full_address: Joi.string().allow('', null).optional(),
  latitude: Joi.number().min(-90).max(90).allow(null).optional(),
  longitude: Joi.number().min(-180).max(180).allow(null).optional(),
  notes: Joi.string().allow('', null).optional(),
  is_active: Joi.boolean().default(true),
  is_pickup_address: Joi.boolean().default(true),
  is_dropoff_address: Joi.boolean().default(true),
  contact_person: Joi.string().max(100).allow('', null).optional(),
  contact_phone: Joi.string().pattern(/^(\+30)?[0-9]{10}$/).allow('', null).optional(),
  priority_order: Joi.number().integer().min(0).default(0)
});

// Health check
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'student-data',
    message: 'Student data service is running' 
  });
});

// Get all students (Admin only)
router.get('/', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { stop_id, parent_id, search } = req.query;

    let query = supabase
      .from('students')
      .select(`
        *,
        parent:profiles!parent_id(*),
        stop:stops(*),
        addresses:student_addresses(*)
      `)
      .order('name');

    if (stop_id) {
      query = query.eq('stop_id', stop_id);
    }
    if (parent_id) {
      query = query.eq('parent_id', parent_id);
    }
    if (search) {
      query = query.ilike('name', `%${search}%`);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch students', { error });
      return res.status(500).json({ error: 'Failed to fetch students' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get students error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export students to CSV (Admin only)
router.get('/export', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { data: students, error } = await supabase
      .from('students')
      .select(`
        *,
        parent:profiles!parent_id(full_name, email, phone),
        stop:stops(name, route:routes(name))
      `)
      .order('name');

    if (error) {
      logger.error('Failed to fetch students for export', { error });
      return res.status(500).json({ error: 'Failed to fetch students' });
    }

    // Format data for CSV export
    const csvData = students.map(student => {
      const primaryAddress = student.addresses?.find(addr => addr.address_type === 'primary');
      return {
        'Όνομα': student.name,
        'Τάξη': student.grade,
        'Διεύθυνση': primaryAddress?.full_address || '',
        'Ιατρικές Πληροφορίες': student.medical_info || '',
      'Δευτερεύουσα Επαφή': student.emergency_contact || '',
      'Τηλέφωνο Δευτερεύουσας Επαφής': student.emergency_phone || '',
      'Email Γονέα': student.parent?.email || '',
      'Όνομα Γονέα': student.parent?.full_name || '',
      'Τηλέφωνο Γονέα': student.parent?.phone || '',
      'Στάση': student.stop?.name || '',
      'Διαδρομή': student.stop?.route?.name || '',
      'Ενεργός': student.is_active ? 'Ναι' : 'Όχι'
      };
    });

    // Convert to CSV
    if (csvData.length === 0) {
      return res.status(200).send('Δεν υπάρχουν μαθητές για εξαγωγή');
    }

    const headers = Object.keys(csvData[0]);
    const csvContent = [
      headers.join(','),
      ...csvData.map(row => 
        headers.map(header => 
          `"${(row[header] || '').toString().replace(/"/g, '""')}"`
        ).join(',')
      )
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=students_export.csv');
    res.send('\uFEFF' + csvContent); // Add BOM for proper UTF-8 encoding in Excel
  } catch (error) {
    logger.error('Export students error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== TIME SLOTS MANAGEMENT ENDPOINTS ====================

// Time slot validation schema
const timeSlotSchema = Joi.object({
  slot_name: Joi.string().min(2).max(100).required(),
  time_value: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).required(),
  slot_type: Joi.string().valid('pickup', 'dropoff').required(),
  is_active: Joi.boolean().default(true),
  display_order: Joi.number().integer().min(0).default(0)
});

// Get all time slots (Admin only)
router.get('/time-slots', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('school_time_slots')
      .select('*')
      .order('slot_type', { ascending: true })
      .order('display_order', { ascending: true });

    if (error) {
      logger.error('Failed to fetch time slots', { error });
      return res.status(500).json({ error: 'Failed to fetch time slots' });
    }

    res.json({ data: data || [] });
  } catch (error) {
    logger.error('Get time slots error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new time slot (Admin only)
router.post('/time-slots', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { error: validationError, value } = timeSlotSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    const { data, error } = await supabase
      .from('school_time_slots')
      .insert(value)
      .select()
      .single();

    if (error) {
      logger.error('Failed to create time slot', { error });
      return res.status(500).json({ error: 'Failed to create time slot' });
    }

    logger.info('Time slot created', { timeSlotId: data.id, userId: req.user.id });
    res.status(201).json({ data });
  } catch (error) {
    logger.error('Create time slot error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update time slot (Admin only)
router.put('/time-slots/:id', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { error: validationError, value } = timeSlotSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    const { data, error } = await supabase
      .from('school_time_slots')
      .update(value)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Time slot not found' });
      }
      logger.error('Failed to update time slot', { error });
      return res.status(500).json({ error: 'Failed to update time slot' });
    }

    logger.info('Time slot updated', { timeSlotId: id, userId: req.user.id });
    res.json({ data });
  } catch (error) {
    logger.error('Update time slot error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete time slot (Admin only)
router.delete('/time-slots/:id', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('school_time_slots')
      .delete()
      .eq('id', id);

    if (error) {
      logger.error('Failed to delete time slot', { error });
      return res.status(500).json({ error: 'Failed to delete time slot' });
    }

    logger.info('Time slot deleted', { timeSlotId: id, userId: req.user.id });
    res.json({ message: 'Time slot deleted successfully' });
  } catch (error) {
    logger.error('Delete time slot error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get student by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Check authorization
    let query = supabase
      .from('students')
      .select(`
        *,
        parent:profiles!parent_id(*),
        stop:stops(*, route:routes(*))
      `)
      .eq('id', id);

    // Parents can only see their own children
    if (req.user.role === 'parent') {
      query = query.eq('parent_id', req.user.id);
    }

    const { data, error } = await query.single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Student not found' });
      }
      logger.error('Failed to fetch student', { error });
      return res.status(500).json({ error: 'Failed to fetch student' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get student error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create student (Admin only)
router.post('/', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { error: validationError, value } = studentSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    // Extract parent data
    const { parent_email, parent_name, parent_phone, ...studentData } = value;

    // Check if parent exists
    let { data: parent } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', parent_email)
      .single();

    let parentWasCreated = false;
    
    // Create parent if doesn't exist
    if (!parent) {
      parentWasCreated = true;
      // Create auth user
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: parent_email,
        password: Math.random().toString(36).slice(-12), // Temporary random password
        email_confirm: true,
        user_metadata: {
          full_name: parent_name
        }
      });

      if (authError) {
        logger.error('Failed to create parent auth', { error: authError });
        return res.status(500).json({ error: 'Failed to create parent account' });
      }

      // Send welcome email with magic link for new parents
      const { data: magicLinkData, error: magicLinkError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: parent_email,
        options: {
          redirectTo: `${process.env.REACT_APP_PARENT_URL || 'http://localhost:3001'}/welcome`
        }
      });

      if (magicLinkError) {
        logger.warn('Failed to send welcome magic link to new parent', { 
          error: magicLinkError, 
          parentEmail: parent_email 
        });
        // Don't fail the student creation if email fails, just log it
      } else {
        logger.info('Welcome magic link sent to new parent', { 
          parentEmail: parent_email,
          magicLink: magicLinkData.properties?.action_link 
        });
      }

      // Update the existing profile created by the trigger, or create if doesn't exist
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .upsert({
          id: authData.user.id,
          email: parent_email,
          full_name: parent_name,
          phone: parent_phone,
          role: 'parent'
        })
        .select()
        .single();

      if (profileError) {
        logger.error('Failed to create/update parent profile', { error: profileError });
        return res.status(500).json({ error: 'Failed to create parent profile' });
      }

      parent = profileData;
    }

    // Create student
    const { data: student, error: studentError } = await supabase
      .from('students')
      .insert({
        ...studentData,
        parent_id: parent.id
      })
      .select(`
        *,
        parent:profiles!parent_id(*),
        stop:stops(*)
      `)
      .single();

    if (studentError) {
      logger.error('Failed to create student', { error: studentError });
      return res.status(500).json({ error: 'Failed to create student' });
    }

    logger.info('Student created', { studentId: student.id, userId: req.user.id });

    // Include information about parent account creation in response
    const response = { data: student };
    if (parentWasCreated) {
      response.parentAccountCreated = true;
      response.message = 'Μαθητής δημιουργήθηκε επιτυχώς. Ο γονέας θα λάβει email καλωσορίσματος με σύνδεσμο για πρόσβαση στην εφαρμογή.';
    }

    res.status(201).json(response);
  } catch (error) {
    logger.error('Create student error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update student (Admin only)
router.put('/:id', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};

    // Validate and pick allowed fields
    const allowedFields = ['name', 'grade', 'medical_info', 'emergency_contact', 'emergency_phone', 'external_student_id', 'stop_id', 'is_active'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('students')
      .update(updates)
      .eq('id', id)
      .select(`
        *,
        parent:profiles!parent_id(*),
        stop:stops(*)
      `)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Student not found' });
      }
      logger.error('Failed to update student', { error });
      return res.status(500).json({ error: 'Failed to update student' });
    }

    logger.info('Student updated', { studentId: id, userId: req.user.id });

    res.json({ data });
  } catch (error) {
    logger.error('Update student error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all students assigned to a specific route (Admin only)
router.get('/route/:routeId', authenticateToken, authorizeRoles(['admin', 'dispatcher']), async (req, res) => {
  try {
    const { routeId } = req.params;

    // Get students assigned to any stop in this route
    const { data, error } = await supabase
      .from('students')
      .select(`
        id,
        name,
        grade,
        medical_info,
        emergency_contact,
        emergency_phone,
        is_active,
        addresses:student_addresses(*),
        parent:profiles!parent_id(id, full_name, phone),
        stop:stops!stop_id(id, name, route_id)
      `)
      .eq('stops.route_id', routeId)
      .eq('is_active', true)
      .order('name');

    if (error) {
      logger.error('Failed to fetch students for route', { error, routeId });
      return res.status(500).json({ error: 'Failed to fetch students for route' });
    }

    // Also get students from student_stops table (many-to-many relationship)
    const { data: stopStudents, error: stopError } = await supabase
      .from('student_stops')
      .select(`
        student:students(
          id,
          name,
          grade,
          address,
          medical_info,
          emergency_contact,
          emergency_phone,
          is_active,
          parent:profiles!parent_id(id, full_name, phone)
        ),
        stop:stops(id, name, route_id)
      `)
      .eq('stops.route_id', routeId)
      .eq('is_active', true);

    if (stopError) {
      logger.error('Failed to fetch students from student_stops for route', { error: stopError, routeId });
    }

    // Combine and deduplicate students
    const allStudents = [...(data || [])];
    if (stopStudents) {
      stopStudents.forEach(ss => {
        if (ss.student && !allStudents.find(s => s.id === ss.student.id)) {
          allStudents.push({
            ...ss.student,
            stop: ss.stop
          });
        }
      });
    }

    // Format student data for frontend
    const formattedStudents = allStudents.map(student => ({
      id: student.id,
      name: student.name,
      full_name: student.name, // For compatibility
      grade: student.grade,
      address: student.addresses?.find(addr => addr.address_type === 'primary')?.full_address || '',
      medical_info: student.medical_info,
      emergency_contact: student.emergency_contact,
      emergency_phone: student.emergency_phone,
      is_active: student.is_active,
      parent_name: student.parent?.full_name || '',
      parent_phone: student.parent?.phone || '',
      stop_name: student.stop?.name || '',
      age: null // Calculate age if needed
    }));

    logger.info('Students fetched for route', { 
      routeId, 
      count: formattedStudents.length,
      userId: req.user.id 
    });

    res.json({ data: formattedStudents });

  } catch (error) {
    logger.error('Get route students error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get students for a specific route and stop (Driver/Admin only)
router.get('/route/:routeId/stop/:stopId', authenticateToken, authorizeRoles(['driver', 'escort', 'admin', 'dispatcher']), async (req, res) => {
  try {
    const { routeId, stopId } = req.params;

    // Fetch students from the database based on stop_id
    const { data: students, error } = await supabase
      .from('students')
      .select(`
        id,
        name,
        grade,
        address,
        medical_info,
        emergency_contact,
        emergency_phone,
        parent:profiles!parent_id(
          id,
          full_name,
          phone,
          email
        )
      `)
      .eq('stop_id', stopId)
      .eq('is_active', true)
      .order('name');

    if (error) {
      logger.error('Failed to fetch students for stop', { error, routeId, stopId });
      return res.status(500).json({ error: 'Failed to fetch students' });
    }

    // Transform data to match frontend expectations
    const studentsFormatted = students.map(student => ({
      id: student.id,
      name: student.name,
      grade: student.grade,
      medical_info: student.medical_info,
      emergency_contact: student.emergency_contact,
      emergency_phone: student.emergency_phone,
      parent_phone: student.parent?.phone,
      parent_name: student.parent?.full_name,
      parent_email: student.parent?.email,
      home_address: student.addresses?.find(addr => addr.address_type === 'primary')?.full_address || ''
    }));

    logger.info('Students fetched for route/stop', { 
      routeId, 
      stopId, 
      count: studentsFormatted.length,
      driverId: req.user.id 
    });

    res.json(studentsFormatted);
  } catch (error) {
    logger.error('Get students error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get students by stop (Driver/Admin only)
router.get('/stop/:stopId', authenticateToken, authorizeRoles(['driver', 'escort', 'admin', 'dispatcher']), async (req, res) => {
  try {
    const { stopId } = req.params;

    const { data: students, error } = await supabase
      .from('students')
      .select(`
        *,
        parent:profiles!parent_id(
          id,
          full_name,
          phone,
          email
        )
      `)
      .eq('stop_id', stopId)
      .eq('is_active', true)
      .order('name');

    if (error) {
      logger.error('Failed to fetch students for stop', { error });
      return res.status(500).json({ error: 'Failed to fetch students' });
    }

    res.json({ students });
  } catch (error) {
    logger.error('Get students by stop error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete student (Admin only)
router.delete('/:id', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('students')
      .delete()
      .eq('id', id);

    if (error) {
      logger.error('Failed to delete student', { error });
      return res.status(500).json({ error: 'Failed to delete student' });
    }

    logger.info('Student deleted', { studentId: id, userId: req.user.id });

    res.json({ message: 'Student deleted successfully' });
  } catch (error) {
    logger.error('Delete student error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Import students from CSV/Excel (Admin only)
router.post('/import', authenticateToken, authorizeRoles(['admin']), upload.single('file'), async (req, res) => {
  let filePath = null;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    let students = [];

    if (fileExt === '.csv') {
      // Parse CSV
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const parser = csv.parse(fileContent, {
        columns: true,
        skip_empty_lines: true
      });

      for await (const record of parser) {
        students.push(record);
      }
    } else if (fileExt === '.xlsx' || fileExt === '.xls') {
      // Parse Excel
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      students = xlsx.utils.sheet_to_json(worksheet);
    } else {
      return res.status(400).json({ error: 'Unsupported file format' });
    }

    // Process students
    const results = {
      successful: 0,
      failed: 0,
      errors: []
    };

    for (const studentData of students) {
      try {
        // Map fields from import to our schema
        const mappedData = {
          name: studentData.name || studentData.Name || studentData['Όνομα'],
          grade: studentData.grade || studentData.Grade || studentData['Τάξη'],
          address: studentData.address || studentData.Address || studentData['Διεύθυνση'],
          medical_info: studentData.medical_info || studentData['Medical Info'] || studentData['Ιατρικές Πληροφορίες'] || '',
          external_student_id: studentData.external_student_id || studentData['External Student ID'] || studentData['Κωδικός Μαθητή'] || '',
          emergency_contact: studentData.emergency_contact || studentData['Emergency Contact'] || studentData['Δευτερεύουσα Επαφή'] || '',
          emergency_phone: studentData.emergency_phone || studentData['Emergency Phone'] || studentData['Τηλέφωνο Έκτακτης Ανάγκης'] || '',
          parent_email: studentData.parent_email || studentData['Parent Email'] || studentData['Email Γονέα'],
          parent_name: studentData.parent_name || studentData['Parent Name'] || studentData['Όνομα Γονέα'],
          parent_phone: studentData.parent_phone || studentData['Parent Phone'] || studentData['Τηλέφωνο Γονέα']
        };

        // Validate
        const { error: validationError, value } = studentSchema.validate(mappedData);
        if (validationError) {
          results.failed++;
          results.errors.push({
            row: results.successful + results.failed,
            error: validationError.details[0].message,
            data: studentData
          });
          continue;
        }

        // Process parent and address
        const { parent_email, parent_name, parent_phone, address, ...studentInfo } = value;

        // Check if parent exists
        let { data: parent } = await supabase
          .from('profiles')
          .select('id')
          .eq('email', parent_email)
          .single();

        // Create parent if doesn't exist
        if (!parent) {
          const { data: authData, error: authError } = await supabase.auth.admin.createUser({
            email: parent_email,
            password: Math.random().toString(36).slice(-12), // Temporary random password
            email_confirm: true,
            user_metadata: {
              full_name: parent_name
            }
          });

          if (authError) {
            results.failed++;
            results.errors.push({
              row: results.successful + results.failed,
              error: 'Failed to create parent account',
              data: studentData
            });
            continue;
          }

          // Send welcome email with magic link for new parents
          const { data: magicLinkData, error: magicLinkError } = await supabase.auth.admin.generateLink({
            type: 'magiclink',
            email: parent_email,
            options: {
              redirectTo: `${process.env.REACT_APP_PARENT_URL || 'http://localhost:3001'}/welcome`
            }
          });

          if (magicLinkError) {
            logger.warn('Failed to send welcome magic link during import', { 
              error: magicLinkError, 
              parentEmail: parent_email 
            });
            // Don't fail the import if email fails, just log it
          }

          // Update the existing profile created by the trigger, or create if doesn't exist
          const { data: profileData, error: profileError } = await supabase
            .from('profiles')
            .upsert({
              id: authData.user.id,
              email: parent_email,
              full_name: parent_name,
              phone: parent_phone,
              role: 'parent'
            })
            .select()
            .single();

          if (profileError) {
            results.failed++;
            results.errors.push({
              row: results.successful + results.failed,
              error: 'Failed to create parent profile',
              data: studentData
            });
            continue;
          }

          parent = profileData;
        }

        // Create student
        const { data: createdStudent, error: studentError } = await supabase
          .from('students')
          .insert({
            ...studentInfo,
            parent_id: parent.id
          })
          .select()
          .single();

        if (studentError) {
          results.failed++;
          results.errors.push({
            row: results.successful + results.failed,
            error: 'Failed to create student',
            data: studentData
          });
          continue;
        }

        // Create primary address for the student
        if (address && address.trim()) {
          // Parse address to extract street name and number for required fields
          const addressParts = address.trim().match(/^(.+?)\s+(\d+[^\d]*?)(?:,|$)/);
          let streetName = address.trim();
          let streetNumber = '1'; // Default number if can't parse
          
          if (addressParts) {
            streetName = addressParts[1].trim();
            streetNumber = addressParts[2].trim();
          } else {
            // If can't parse, use the full address as street name and default number
            const parts = address.trim().split(/\s+/);
            if (parts.length > 1) {
              // Check if last part looks like a number
              const lastPart = parts[parts.length - 1];
              if (/^\d+[^\d]*$/.test(lastPart)) {
                streetNumber = lastPart;
                streetName = parts.slice(0, -1).join(' ');
              }
            }
          }
          
          const { error: addressError } = await supabase
            .from('student_addresses')
            .insert({
              student_id: createdStudent.id,
              address_type: 'primary',
              street_name: streetName,
              street_number: streetNumber,
              full_address: address.trim(),
              city: 'Αθήνα',
              is_active: true,
              is_pickup_address: true,
              is_dropoff_address: true,
              priority_order: 0
            });

          if (addressError) {
            logger.warn('Failed to create primary address for student during import', { 
              error: addressError, 
              studentId: createdStudent.id,
              address: address.trim()
            });
            // Don't fail the import if address creation fails, just log it
          } else {
            logger.info('Primary address created for student during import', {
              studentId: createdStudent.id,
              address: address.trim()
            });
          }
        }

        results.successful++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          row: results.successful + results.failed,
          error: error.message,
          data: studentData
        });
      }
    }

    logger.info('Student import completed', { 
      successful: results.successful, 
      failed: results.failed,
      userId: req.user.id 
    });

    res.json({
      message: 'Import completed',
      results
    });

  } catch (error) {
    logger.error('Import error', { error: error.message });
    res.status(500).json({ error: 'Import failed' });
  } finally {
    // Clean up uploaded file
    if (filePath) {
      try {
        await fs.unlink(filePath);
      } catch (err) {
        logger.error('Failed to delete uploaded file', { error: err });
      }
    }
  }
});

// Get students by parent (Parent only)
router.get('/parent/children', authenticateToken, authorizeRoles(['parent']), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('students')
      .select(`
        *,
        stop:stops(*, route:routes(*))
      `)
      .eq('parent_id', req.user.id)
      .order('name');

    if (error) {
      logger.error('Failed to fetch children', { error });
      return res.status(500).json({ error: 'Failed to fetch children' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get children error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign student to stop (Admin only)
router.post('/:studentId/assign-stop', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { stop_id } = req.body;

    if (!stop_id) {
      return res.status(400).json({ error: 'Stop ID required' });
    }

    // Verify stop exists
    const { data: stop } = await supabase
      .from('stops')
      .select('id')
      .eq('id', stop_id)
      .single();

    if (!stop) {
      return res.status(404).json({ error: 'Stop not found' });
    }

    // Update student
    const { data, error } = await supabase
      .from('students')
      .update({ stop_id })
      .eq('id', studentId)
      .select(`
        *,
        stop:stops(*, route:routes(*))
      `)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Student not found' });
      }
      logger.error('Failed to assign stop', { error });
      return res.status(500).json({ error: 'Failed to assign stop' });
    }

    logger.info('Student assigned to stop', { 
      studentId, 
      stopId: stop_id, 
      userId: req.user.id 
    });

    res.json({ data });
  } catch (error) {
    logger.error('Assign stop error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Batch save attendance (Driver only)
router.post('/attendance/batch', authenticateToken, authorizeRoles(['driver', 'escort']), async (req, res) => {
  try {
    const { attendance } = req.body;

    if (!Array.isArray(attendance) || attendance.length === 0) {
      return res.status(400).json({ error: 'Invalid attendance data' });
    }

    // Validate attendance records
    const attendanceSchema = Joi.object({
      schedule_id: Joi.string().uuid().required(),
      student_id: Joi.string().uuid().required(),
      status: Joi.string().valid('present', 'absent', 'no_show').required(),
      boarded_at: Joi.date().iso().allow(null)
    });

    const validationErrors = [];
    const validRecords = [];

    attendance.forEach((record, index) => {
      const { error, value } = attendanceSchema.validate(record);
      if (error) {
        validationErrors.push({ index, error: error.details[0].message });
      } else {
        validRecords.push({
          ...value,
          created_at: new Date().toISOString()
        });
      }
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        error: 'Validation errors in attendance data',
        errors: validationErrors 
      });
    }

    // Insert attendance records
    const { data, error } = await supabase
      .from('attendance')
      .insert(validRecords)
      .select();

    if (error) {
      logger.error('Failed to save attendance', { error });
      return res.status(500).json({ error: 'Failed to save attendance' });
    }

    logger.info('Attendance saved', { 
      count: data.length,
      userId: req.user.id 
    });

    res.json({ 
      message: 'Attendance saved successfully',
      count: data.length 
    });
  } catch (error) {
    logger.error('Batch attendance error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export template (Admin only)
router.get('/template/download', authenticateToken, authorizeRoles(['admin']), (req, res) => {
  const template = [
    {
      'name': 'Μαρία Παπαδοπούλου',
      'grade': '4',
      'parent_email': 'parent1@example.com',
      'parent_name': 'Γιώργος Παπαδόπουλος',
      'parent_phone': '+306912345678',
      'address': 'Πατησίων 45, Εξάρχεια, 10681 Αθήνα',
      'external_student_id': '10001',
      'medical_info': 'Αλλεργία στα φιστίκια',
      'emergency_contact': 'Γιαγιά Ελένη',
      'emergency_phone': '6923456001'
    },
    {
      'name': 'Νίκος Γεωργίου',
      'grade': '5',
      'parent_email': 'parent2@example.com',
      'parent_name': 'Ελένη Γεωργίου',
      'parent_phone': '6923456789',
      'address': 'Σταδίου 10, Κέντρο, 10564 Αθήνα',
      'external_student_id': '10002',
      'medical_info': '',
      'emergency_contact': 'Παππούς Νίκος',
      'emergency_phone': '6923456002'
    }
  ];

  const ws = xlsx.utils.json_to_sheet(template);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Students');

  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=student_import_template.xlsx');
  res.send(buffer);
});


// Get students for a parent
router.get('/parent/:parentId', authenticateToken, authorizeRoles(['parent', 'admin']), async (req, res) => {
  try {
    const { parentId } = req.params;
    
    // Verify parent is accessing their own data
    if (req.user.role === 'parent' && req.user.id !== parentId) {
      return res.status(403).json({ error: 'Unauthorized access' });
    }

    const { data: students, error } = await supabase
      .from('students')
      .select(`
        *,
        stop:stops(*, route:routes(*)),
        parent:profiles!parent_id(*)
      `)
      .eq('parent_id', parentId)
      .eq('is_active', true);

    if (error) {
      logger.error('Failed to fetch parent students:', error);
      return res.status(500).json({ error: 'Failed to fetch students' });
    }

    // Get current trip info for each student
    const studentsWithTripInfo = await Promise.all(students.map(async (student) => {
      if (!student.stop?.route_id) return student;

      // Check if there's an active trip for this route
      const { data: activeTrip } = await supabase
        .from('trips')
        .select(`
          *,
          bus:buses(*),
          driver:profiles!driver_id(*)
        `)
        .eq('route_id', student.stop.route_id)
        .eq('status', 'in_progress')
        .single();

      if (activeTrip) {
        // Get latest attendance status for today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const { data: attendance } = await supabase
          .from('attendance')
          .select('status')
          .eq('student_id', student.id)
          .gte('created_at', today.toISOString())
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        return {
          ...student,
          current_trip: activeTrip,
          attendance_status: attendance?.status,
          bus: activeTrip.bus,
          driver: activeTrip.driver
        };
      }

      return student;
    }));

    res.json({ students: studentsWithTripInfo });
  } catch (error) {
    logger.error('Error fetching parent students:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single student details (for parent)
router.get('/:studentId', authenticateToken, authorizeRoles(['parent', 'admin', 'driver', 'escort']), async (req, res) => {
  try {
    const { studentId } = req.params;

    const { data: student, error } = await supabase
      .from('students')
      .select(`
        *,
        stop:stops(*, route:routes(*)),
        parent:profiles!parent_id(*)
      `)
      .eq('id', studentId)
      .single();

    if (error) {
      logger.error('Failed to fetch student:', error);
      return res.status(404).json({ error: 'Student not found' });
    }

    // Verify parent is accessing their own child's data
    if (req.user.role === 'parent' && student.parent_id !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized access' });
    }

    // Get current trip info
    if (student.stop?.route_id) {
      const { data: activeTrip } = await supabase
        .from('trips')
        .select(`
          *,
          bus:buses(*),
          driver:profiles!driver_id(*)
        `)
        .eq('route_id', student.stop.route_id)
        .eq('status', 'in_progress')
        .single();

      if (activeTrip) {
        student.current_trip = activeTrip;
        student.bus = activeTrip.bus;
        student.driver = activeTrip.driver;
      }
    }

    res.json({ student });
  } catch (error) {
    logger.error('Error fetching student:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get student route assignments
router.get('/:studentId/routes', authenticateToken, authorizeRoles(['admin', 'parent']), async (req, res) => {
  try {
    const { studentId } = req.params;

    // Verify parent is accessing their own child's data
    if (req.user.role === 'parent') {
      const { data: student } = await supabase
        .from('students')
        .select('parent_id')
        .eq('id', studentId)
        .single();

      if (!student || student.parent_id !== req.user.id) {
        return res.status(403).json({ error: 'Unauthorized access' });
      }
    }

    const { data, error } = await supabase
      .from('student_stops')
      .select(`
        *,
        stop:stops(*, route:routes(*))
      `)
      .eq('student_id', studentId)
      .eq('is_active', true)
      .order('created_at');

    if (error) {
      logger.error('Failed to fetch student routes', { error });
      return res.status(500).json({ error: 'Failed to fetch student routes' });
    }

    res.json({ data });
  } catch (error) {
    logger.error('Get student routes error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add route assignment to student (Admin only)
router.post('/:studentId/routes', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { stop_id, route_type = 'regular', notes } = req.body;

    if (!stop_id) {
      return res.status(400).json({ error: 'Stop ID required' });
    }

    // Verify student exists
    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('id', studentId)
      .single();

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Verify stop exists
    const { data: stop } = await supabase
      .from('stops')
      .select('id, route_id')
      .eq('id', stop_id)
      .single();

    if (!stop) {
      return res.status(404).json({ error: 'Stop not found' });
    }

    // Insert into junction table
    const { data, error } = await supabase
      .from('student_stops')
      .insert({
        student_id: studentId,
        stop_id,
        route_type,
        notes,
        is_active: true
      })
      .select(`
        *,
        stop:stops(*, route:routes(*))
      `)
      .single();

    if (error) {
      if (error.code === '23505') { // Unique constraint violation
        return res.status(400).json({ 
          error: 'Student is already assigned to this stop for this route type' 
        });
      }
      logger.error('Failed to assign student to route', { error });
      return res.status(500).json({ error: 'Failed to assign student to route' });
    }

    logger.info('Student assigned to route', { 
      studentId, 
      stopId: stop_id, 
      routeType: route_type,
      userId: req.user.id 
    });

    res.status(201).json({ data });
  } catch (error) {
    logger.error('Add student route error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update route assignment (Admin only)
router.put('/:studentId/routes/:assignmentId', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId, assignmentId } = req.params;
    const { stop_id, route_type, notes, is_active } = req.body;

    const updates = {};
    if (stop_id) updates.stop_id = stop_id;
    if (route_type) updates.route_type = route_type;
    if (notes !== undefined) updates.notes = notes;
    if (is_active !== undefined) updates.is_active = is_active;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('student_stops')
      .update(updates)
      .eq('id', assignmentId)
      .eq('student_id', studentId)
      .select(`
        *,
        stop:stops(*, route:routes(*))
      `)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Assignment not found' });
      }
      logger.error('Failed to update route assignment', { error });
      return res.status(500).json({ error: 'Failed to update route assignment' });
    }

    logger.info('Route assignment updated', { 
      assignmentId, 
      studentId,
      userId: req.user.id 
    });

    res.json({ data });
  } catch (error) {
    logger.error('Update route assignment error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove route assignment (Admin only)
router.delete('/:studentId/routes/:assignmentId', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId, assignmentId } = req.params;

    const { error } = await supabase
      .from('student_stops')
      .delete()
      .eq('id', assignmentId)
      .eq('student_id', studentId);

    if (error) {
      logger.error('Failed to remove route assignment', { error });
      return res.status(500).json({ error: 'Failed to remove route assignment' });
    }

    logger.info('Route assignment removed', { 
      assignmentId, 
      studentId,
      userId: req.user.id 
    });

    res.json({ message: 'Route assignment removed successfully' });
  } catch (error) {
    logger.error('Remove route assignment error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Batch assign multiple stops to student (Admin only)
router.post('/:studentId/routes/batch', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { assignments } = req.body;

    if (!Array.isArray(assignments) || assignments.length === 0) {
      return res.status(400).json({ error: 'Assignments array required' });
    }

    // Verify student exists
    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('id', studentId)
      .single();

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Prepare batch insert data
    const insertData = assignments.map(assignment => ({
      student_id: studentId,
      stop_id: assignment.stop_id,
      route_type: assignment.route_type || 'regular',
      notes: assignment.notes || null,
      is_active: assignment.is_active !== undefined ? assignment.is_active : true
    }));

    const { data, error } = await supabase
      .from('student_stops')
      .insert(insertData)
      .select(`
        *,
        stop:stops(*, route:routes(*))
      `);

    if (error) {
      logger.error('Failed to batch assign routes', { error });
      return res.status(500).json({ error: 'Failed to assign routes' });
    }

    logger.info('Batch route assignments created', { 
      studentId,
      count: data.length,
      userId: req.user.id 
    });

    res.status(201).json({ data });
  } catch (error) {
    logger.error('Batch assign routes error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== STUDENT ADDRESS MANAGEMENT ENDPOINTS ====================

// Get all addresses for a student
router.get('/:studentId/addresses', authenticateToken, authorizeRoles(['admin', 'parent']), async (req, res) => {
  try {
    const { studentId } = req.params;
    
    // For parent role, verify they own this student
    if (req.user.role === 'parent') {
      const { data: student } = await supabase
        .from('students')
        .select('parent_id')
        .eq('id', studentId)
        .single();
        
      if (!student || student.parent_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { data, error } = await supabase
      .from('student_addresses')
      .select('*')
      .eq('student_id', studentId)
      .order('priority_order', { ascending: true });

    if (error) {
      logger.error('Failed to fetch student addresses', { error });
      return res.status(500).json({ error: 'Failed to fetch addresses' });
    }

    res.json({ data: data || [] });
  } catch (error) {
    logger.error('Get student addresses error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new address for student
router.post('/:studentId/addresses', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const { error: validationError, value } = studentAddressSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    // Check if student exists
    const { data: student, error: studentError } = await supabase
      .from('students')
      .select('id')
      .eq('id', studentId)
      .single();

    if (studentError || !student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // If this is a primary address, deactivate other primary addresses
    if (value.address_type === 'primary') {
      await supabase
        .from('student_addresses')
        .update({ is_active: false })
        .eq('student_id', studentId)
        .eq('address_type', 'primary');
    }

    // Try to geocode the address (commented out for now - activate after testing)
    let coordinates = null;
    // if (value.full_address) {
    //   try {
    //     coordinates = await geocodingService.geocodeAddress(value.full_address, 'GR');
    //     if (coordinates) {
    //       logger.info('Address geocoded successfully', { 
    //         address: value.full_address, 
    //         latitude: coordinates.latitude, 
    //         longitude: coordinates.longitude,
    //         cached: coordinates.cached 
    //       });
    //     }
    //   } catch (geocodingError) {
    //     logger.warn('Failed to geocode address during creation', { 
    //       error: geocodingError.message, 
    //       address: value.full_address 
    //     });
    //   }
    // }

    const addressData = {
      ...value,
      student_id: studentId
    };

    // Check if coordinates were passed from frontend (e.g., from test button)
    if (req.body._geocoded_coordinates) {
      const coords = req.body._geocoded_coordinates;
      addressData.latitude = coords.latitude;
      addressData.longitude = coords.longitude;
      addressData.postal_code = coords.postal_code || value.postal_code;
      
      logger.info('Using coordinates passed from frontend for new address', { 
        studentId, 
        coordinates: { lat: coords.latitude, lon: coords.longitude },
        cached: coords.cached 
      });
    } else if (coordinates) {
      // Add coordinates if geocoding was successful (when automatic geocoding is enabled)
      addressData.latitude = coordinates.latitude;
      addressData.longitude = coordinates.longitude;
      addressData.postal_code = coordinates.postal_code || value.postal_code;
    }

    const { data, error } = await supabase
      .from('student_addresses')
      .insert(addressData)
      .select()
      .single();

    if (error) {
      logger.error('Failed to create student address', { error });
      return res.status(500).json({ error: 'Failed to create address' });
    }

    logger.info('Student address created', { 
      studentId, 
      addressId: data.id, 
      userId: req.user.id 
    });
    
    res.status(201).json({ data });
  } catch (error) {
    logger.error('Create student address error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update student address
router.put('/:studentId/addresses/:addressId', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId, addressId } = req.params;
    
    const { error: validationError, value } = studentAddressSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    // If this is being set as primary address, deactivate other primary addresses
    if (value.address_type === 'primary') {
      await supabase
        .from('student_addresses')
        .update({ is_active: false })
        .eq('student_id', studentId)
        .eq('address_type', 'primary')
        .neq('id', addressId);
    }

    // Try to geocode the address if full_address was updated (commented out for now)
    let coordinates = null;
    // if (value.full_address) {
    //   try {
    //     coordinates = await geocodingService.geocodeAddress(value.full_address, 'GR');
    //     if (coordinates) {
    //       logger.info('Address geocoded successfully during update', { 
    //         address: value.full_address, 
    //         latitude: coordinates.latitude, 
    //         longitude: coordinates.longitude,
    //         cached: coordinates.cached,
    //         addressId 
    //       });
    //     }
    //   } catch (geocodingError) {
    //     logger.warn('Failed to geocode address during update', { 
    //       error: geocodingError.message, 
    //       address: value.full_address,
    //       addressId 
    //     });
    //   }
    // }

    const updateData = { ...value };

    // Check if coordinates were passed from frontend (e.g., from test button)
    if (req.body._geocoded_coordinates) {
      const coords = req.body._geocoded_coordinates;
      updateData.latitude = coords.latitude;
      updateData.longitude = coords.longitude;
      updateData.postal_code = coords.postal_code || value.postal_code;
      
      logger.info('Using coordinates passed from frontend', { 
        addressId, 
        coordinates: { lat: coords.latitude, lon: coords.longitude },
        cached: coords.cached 
      });
    } else if (coordinates) {
      // Add coordinates if geocoding was successful (when automatic geocoding is enabled)
      updateData.latitude = coordinates.latitude;
      updateData.longitude = coordinates.longitude;
      updateData.postal_code = coordinates.postal_code || value.postal_code;
    }

    const { data, error } = await supabase
      .from('student_addresses')
      .update(updateData)
      .eq('id', addressId)
      .eq('student_id', studentId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Address not found' });
      }
      logger.error('Failed to update student address', { error });
      return res.status(500).json({ error: 'Failed to update address' });
    }

    logger.info('Student address updated', { 
      studentId, 
      addressId, 
      userId: req.user.id 
    });
    
    res.json({ data });
  } catch (error) {
    logger.error('Update student address error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete student address
router.delete('/:studentId/addresses/:addressId', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId, addressId } = req.params;

    // Check if this is the only primary address
    const { data: addresses, error: checkError } = await supabase
      .from('student_addresses')
      .select('id, address_type')
      .eq('student_id', studentId)
      .eq('is_active', true);

    if (checkError) {
      logger.error('Failed to check student addresses', { error: checkError });
      return res.status(500).json({ error: 'Failed to check addresses' });
    }

    const addressToDelete = addresses?.find(addr => addr.id === addressId);
    const primaryAddresses = addresses?.filter(addr => addr.address_type === 'primary') || [];

    if (addressToDelete?.address_type === 'primary' && primaryAddresses.length === 1) {
      return res.status(400).json({ 
        error: 'Δεν μπορείτε να διαγράψετε την μοναδική κύρια διεύθυνση. Προσθέστε πρώτα μια νέα κύρια διεύθυνση.' 
      });
    }

    const { data, error } = await supabase
      .from('student_addresses')
      .delete()
      .eq('id', addressId)
      .eq('student_id', studentId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Address not found' });
      }
      logger.error('Failed to delete student address', { error });
      return res.status(500).json({ error: 'Failed to delete address' });
    }

    logger.info('Student address deleted', { 
      studentId, 
      addressId, 
      userId: req.user.id 
    });
    
    res.json({ data, message: 'Address deleted successfully' });
  } catch (error) {
    logger.error('Delete student address error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set address priority order
router.put('/:studentId/addresses/reorder', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { addressOrder } = req.body; // Array of {id, priority_order}
    
    if (!Array.isArray(addressOrder)) {
      return res.status(400).json({ error: 'addressOrder must be an array' });
    }

    // Update priority orders
    const updates = addressOrder.map(({ id, priority_order }) => {
      return supabase
        .from('student_addresses')
        .update({ priority_order })
        .eq('id', id)
        .eq('student_id', studentId);
    });

    await Promise.all(updates);

    logger.info('Student address order updated', { 
      studentId, 
      count: addressOrder.length,
      userId: req.user.id 
    });
    
    res.json({ message: 'Address order updated successfully' });
  } catch (error) {
    logger.error('Reorder student addresses error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== STUDENT SCHEDULING ENDPOINTS ====================

// Student schedule validation schema
const scheduleSchema = Joi.object({
  day_of_week: Joi.number().integer().min(0).max(6).required(),
  pickup_address_id: Joi.string().uuid().allow(null).optional(),
  pickup_time_slot_id: Joi.string().uuid().allow(null).optional(),
  dropoff_address_id: Joi.string().uuid().allow(null).optional(),
  dropoff_time_slot_id: Joi.string().uuid().allow(null).optional(),
  is_active: Joi.boolean().default(true),
  notes: Joi.string().max(500).allow('', null).optional()
});

// Get student weekly schedule
router.get('/:studentId/schedule', authenticateToken, authorizeRoles(['admin', 'parent']), async (req, res) => {
  try {
    const { studentId } = req.params;
    
    // For parent role, verify they own this student
    if (req.user.role === 'parent') {
      const { data: student } = await supabase
        .from('students')
        .select('parent_id')
        .eq('id', studentId)
        .single();
        
      if (!student || student.parent_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { data, error } = await supabase
      .from('student_weekly_schedules')
      .select(`
        *,
        pickup_address:student_addresses!pickup_address_id(*),
        pickup_time_slot:school_time_slots!pickup_time_slot_id(*),
        dropoff_address:student_addresses!dropoff_address_id(*),
        dropoff_time_slot:school_time_slots!dropoff_time_slot_id(*)
      `)
      .eq('student_id', studentId)
      .order('day_of_week');

    if (error) {
      logger.error('Failed to fetch student schedule', { error });
      return res.status(500).json({ error: 'Failed to fetch schedule' });
    }

    res.json({ data: data || [] });
  } catch (error) {
    logger.error('Get student schedule error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update student daily schedule (Admin only)
router.put('/:studentId/schedule/:dayOfWeek', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId, dayOfWeek } = req.params;
    const dayNumber = parseInt(dayOfWeek);
    
    if (isNaN(dayNumber) || dayNumber < 0 || dayNumber > 6) {
      return res.status(400).json({ error: 'Invalid day of week (0-6)' });
    }

    const { error: validationError, value } = scheduleSchema.validate({
      ...req.body,
      day_of_week: dayNumber
    });
    
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    // Verify student exists
    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('id', studentId)
      .single();

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Upsert the schedule (insert or update)
    const { data, error } = await supabase
      .from('student_weekly_schedules')
      .upsert({
        student_id: studentId,
        ...value
      })
      .select(`
        *,
        pickup_address:student_addresses!pickup_address_id(*),
        pickup_time_slot:school_time_slots!pickup_time_slot_id(*),
        dropoff_address:student_addresses!dropoff_address_id(*),
        dropoff_time_slot:school_time_slots!dropoff_time_slot_id(*)
      `)
      .single();

    if (error) {
      logger.error('Failed to update student schedule', { error });
      return res.status(500).json({ error: 'Failed to update schedule' });
    }

    logger.info('Student schedule updated', { 
      studentId, 
      dayOfWeek: dayNumber, 
      userId: req.user.id 
    });
    
    res.json({ data });
  } catch (error) {
    logger.error('Update student schedule error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk update student weekly schedule (Admin only)
router.put('/:studentId/schedule', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { schedules } = req.body;

    if (!Array.isArray(schedules)) {
      return res.status(400).json({ error: 'Schedules must be an array' });
    }

    // Verify student exists
    const { data: student, error: studentError } = await supabase
      .from('students')
      .select('id')
      .eq('id', studentId)
      .single();

    if (studentError || !student) {
      logger.error('Student not found', { studentId, error: studentError });
      return res.status(404).json({ error: 'Student not found' });
    }

    // Validate all schedules
    const validatedSchedules = [];
    for (const schedule of schedules) {
      const { error: validationError, value } = scheduleSchema.validate(schedule);
      if (validationError) {
        return res.status(400).json({ 
          error: `Day ${schedule.day_of_week}: ${validationError.details[0].message}` 
        });
      }
      validatedSchedules.push({
        student_id: studentId,
        ...value
      });
    }

    // Upsert all schedules with proper conflict resolution
    const { data, error } = await supabase
      .from('student_weekly_schedules')
      .upsert(validatedSchedules, { 
        onConflict: 'student_id,day_of_week',
        ignoreDuplicates: false 
      })
      .select(`
        *,
        pickup_address:student_addresses!pickup_address_id(*),
        pickup_time_slot:school_time_slots!pickup_time_slot_id(*),
        dropoff_address:student_addresses!dropoff_address_id(*),
        dropoff_time_slot:school_time_slots!dropoff_time_slot_id(*)
      `);

    if (error) {
      logger.error('Failed to bulk update student schedule', { error });
      return res.status(500).json({ error: 'Failed to update schedule' });
    }

    logger.info('Student weekly schedule updated', { 
      studentId, 
      daysUpdated: validatedSchedules.length,
      userId: req.user.id 
    });
    
    res.json({ data });
  } catch (error) {
    logger.error('Bulk update student schedule error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== SCHEDULE EXCEPTIONS ENDPOINTS ====================

// Schedule exception validation schema
const exceptionSchema = Joi.object({
  exception_date: Joi.date().iso().required(),
  pickup_address_id: Joi.string().uuid().allow(null).optional(),
  pickup_time_slot_id: Joi.string().uuid().allow(null).optional(),
  dropoff_address_id: Joi.string().uuid().allow(null).optional(),
  dropoff_time_slot_id: Joi.string().uuid().allow(null).optional(),
  reason: Joi.string().max(100).allow('', null).optional(),
  notes: Joi.string().max(500).allow('', null).optional()
});

// Get student schedule exceptions
router.get('/:studentId/schedule/exceptions', authenticateToken, authorizeRoles(['admin', 'parent']), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { from_date, to_date } = req.query;
    
    // For parent role, verify they own this student
    if (req.user.role === 'parent') {
      const { data: student } = await supabase
        .from('students')
        .select('parent_id')
        .eq('id', studentId)
        .single();
        
      if (!student || student.parent_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    let query = supabase
      .from('student_schedule_exceptions')
      .select(`
        *,
        pickup_address:student_addresses!pickup_address_id(*),
        pickup_time_slot:school_time_slots!pickup_time_slot_id(*),
        dropoff_address:student_addresses!dropoff_address_id(*),
        dropoff_time_slot:school_time_slots!dropoff_time_slot_id(*)
      `)
      .eq('student_id', studentId)
      .order('exception_date');

    if (from_date) {
      query = query.gte('exception_date', from_date);
    }
    if (to_date) {
      query = query.lte('exception_date', to_date);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Failed to fetch schedule exceptions', { error });
      return res.status(500).json({ error: 'Failed to fetch exceptions' });
    }

    res.json({ data: data || [] });
  } catch (error) {
    logger.error('Get schedule exceptions error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create schedule exception (Admin only)
router.post('/:studentId/schedule/exceptions', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const { error: validationError, value } = exceptionSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    // Verify student exists
    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('id', studentId)
      .single();

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const { data, error } = await supabase
      .from('student_schedule_exceptions')
      .upsert({
        student_id: studentId,
        ...value
      })
      .select(`
        *,
        pickup_address:student_addresses!pickup_address_id(*),
        pickup_time_slot:school_time_slots!pickup_time_slot_id(*),
        dropoff_address:student_addresses!dropoff_address_id(*),
        dropoff_time_slot:school_time_slots!dropoff_time_slot_id(*)
      `)
      .single();

    if (error) {
      logger.error('Failed to create schedule exception', { error });
      return res.status(500).json({ error: 'Failed to create exception' });
    }

    logger.info('Schedule exception created', { 
      studentId, 
      exceptionId: data.id, 
      date: value.exception_date,
      userId: req.user.id 
    });
    
    res.status(201).json({ data });
  } catch (error) {
    logger.error('Create schedule exception error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete schedule exception (Admin only)
router.delete('/:studentId/schedule/exceptions/:exceptionId', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId, exceptionId } = req.params;

    const { error } = await supabase
      .from('student_schedule_exceptions')
      .delete()
      .eq('id', exceptionId)
      .eq('student_id', studentId);

    if (error) {
      logger.error('Failed to delete schedule exception', { error });
      return res.status(500).json({ error: 'Failed to delete exception' });
    }

    logger.info('Schedule exception deleted', { 
      studentId, 
      exceptionId, 
      userId: req.user.id 
    });
    
    res.json({ message: 'Exception deleted successfully' });
  } catch (error) {
    logger.error('Delete schedule exception error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update schedule exception (Admin only)
router.put('/:studentId/schedule/exceptions/:exceptionId', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { studentId, exceptionId } = req.params;
    
    // Validate request body using the same schema as POST
    const { error: validationError, value } = exceptionSchema.validate(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError.details[0].message });
    }

    // Verify student exists
    const { data: studentData, error: studentError } = await supabase
      .from('students')
      .select('id')
      .eq('id', studentId)
      .single();

    if (studentError || !studentData) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Update the exception
    const { data, error } = await supabase
      .from('student_schedule_exceptions')
      .update({
        ...value,
        updated_at: new Date().toISOString()
      })
      .eq('id', exceptionId)
      .eq('student_id', studentId)
      .select();

    if (error) {
      logger.error('Failed to update schedule exception', { error });
      return res.status(500).json({ error: 'Failed to update exception' });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Exception not found' });
    }

    logger.info('Schedule exception updated', { 
      studentId, 
      exceptionId, 
      exception_date: value.exception_date,
      userId: req.user.id 
    });
    
    res.json({ message: 'Exception updated successfully', data: data[0] });
  } catch (error) {
    logger.error('Update schedule exception error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== BULK SCHEDULE IMPORT/EXPORT ENDPOINTS ====================

// Export student schedules template (Admin only)
router.get('/schedules/template', authenticateToken, authorizeRoles(['admin']), (req, res) => {
  const template = [
    {
      'student_name': 'Μαρία Παπαδοπούλου',
      'student_id': '',
      'day_of_week': '1',
      'pickup_address_name': 'Σπίτι',
      'pickup_time_slot': 'Κανονική Παραλαβή (08:00)',
      'dropoff_address_name': 'Σπίτι',
      'dropoff_time_slot': 'Κανονική Παράδοση (15:30)',
      'notes': 'Παραδείγματα για Δευτέρα'
    },
    {
      'student_name': 'Μαρία Παπαδοπούλου',
      'student_id': '',
      'day_of_week': '2',
      'pickup_address_name': 'Σπίτι',
      'pickup_time_slot': 'Κανονική Παραλαβή (08:00)',
      'dropoff_address_name': 'Γιαγιά',
      'dropoff_time_slot': 'Κανονική Παράδοση (15:30)',
      'notes': 'Τρίτη πάει στη γιαγιά'
    }
  ];

  const ws = xlsx.utils.json_to_sheet(template);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Schedule Template');

  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=student_schedule_template.xlsx');
  res.send(buffer);
});

// Export all student schedules (Admin only)
router.get('/schedules/export', authenticateToken, authorizeRoles(['admin']), async (req, res) => {
  try {
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select(`
        id,
        name,
        grade,
        parent:profiles!parent_id(full_name, email)
      `)
      .eq('is_active', true)
      .order('name');

    if (studentsError) {
      logger.error('Failed to fetch students for schedule export', { error: studentsError });
      return res.status(500).json({ error: 'Failed to fetch students' });
    }

    const { data: timeSlots, error: slotsError } = await supabase
      .from('school_time_slots')
      .select('*')
      .eq('is_active', true);

    if (slotsError) {
      logger.error('Failed to fetch time slots for export', { error: slotsError });
      return res.status(500).json({ error: 'Failed to fetch time slots' });
    }

    const exportData = [];

    for (const student of students) {
      const { data: schedules } = await supabase
        .from('student_weekly_schedules')
        .select(`
          *,
          pickup_address:student_addresses!pickup_address_id(address_name, street_name, street_number),
          pickup_time_slot:school_time_slots!pickup_time_slot_id(slot_name, time_value),
          dropoff_address:student_addresses!dropoff_address_id(address_name, street_name, street_number),
          dropoff_time_slot:school_time_slots!dropoff_time_slot_id(slot_name, time_value)
        `)
        .eq('student_id', student.id)
        .order('day_of_week');

      const { data: addresses } = await supabase
        .from('student_addresses')
        .select('*')
        .eq('student_id', student.id)
        .eq('is_active', true);

      for (let day = 1; day <= 5; day++) {
        const daySchedule = schedules?.find(s => s.day_of_week === day) || {};
        
        exportData.push({
          'student_name': student.name,
          'student_id': student.id,
          'student_grade': student.grade || '',
          'parent_name': student.parent?.full_name || '',
          'parent_email': student.parent?.email || '',
          'day_of_week': day,
          'day_name': DAYS_OF_WEEK.find(d => d.value === day)?.label || '',
          'pickup_address_name': daySchedule.pickup_address?.address_name || 
                                (daySchedule.pickup_address ? `${daySchedule.pickup_address.street_name} ${daySchedule.pickup_address.street_number}` : ''),
          'pickup_time_slot': daySchedule.pickup_time_slot ? 
                             `${daySchedule.pickup_time_slot.slot_name} (${daySchedule.pickup_time_slot.time_value?.substring(0, 5)})` : '',
          'dropoff_address_name': daySchedule.dropoff_address?.address_name || 
                                 (daySchedule.dropoff_address ? `${daySchedule.dropoff_address.street_name} ${daySchedule.dropoff_address.street_number}` : ''),
          'dropoff_time_slot': daySchedule.dropoff_time_slot ? 
                              `${daySchedule.dropoff_time_slot.slot_name} (${daySchedule.dropoff_time_slot.time_value?.substring(0, 5)})` : '',
          'notes': daySchedule.notes || '',
          'is_active': daySchedule.is_active ? 'Ναι' : 'Όχι'
        });
      }
    }

    const ws = xlsx.utils.json_to_sheet(exportData);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Student Schedules');

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=student_schedules_export.xlsx');
    res.send(buffer);

    logger.info('Student schedules exported', { 
      studentCount: students.length,
      recordCount: exportData.length,
      userId: req.user.id 
    });

  } catch (error) {
    logger.error('Export schedules error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Import student schedules from CSV/Excel (Admin only)
router.post('/schedules/import', authenticateToken, authorizeRoles(['admin']), upload.single('file'), async (req, res) => {
  let filePath = null;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    let scheduleData = [];

    if (fileExt === '.csv') {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const parser = csv.parse(fileContent, {
        columns: true,
        skip_empty_lines: true
      });

      for await (const record of parser) {
        scheduleData.push(record);
      }
    } else if (fileExt === '.xlsx' || fileExt === '.xls') {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      scheduleData = xlsx.utils.sheet_to_json(worksheet);
    } else {
      return res.status(400).json({ error: 'Unsupported file format' });
    }

    const results = {
      successful: 0,
      failed: 0,
      errors: []
    };

    // Get all time slots and students for reference
    const { data: timeSlots } = await supabase
      .from('school_time_slots')
      .select('*')
      .eq('is_active', true);

    const { data: students } = await supabase
      .from('students')
      .select('id, name')
      .eq('is_active', true);

    for (const row of scheduleData) {
      try {
        // Find student by name or ID
        const studentName = row.student_name || row['student_name'] || row['Όνομα Μαθητή'];
        const studentId = row.student_id || row['student_id'] || row['Κωδικός Μαθητή'];
        
        let student = null;
        if (studentId) {
          student = students.find(s => s.id === studentId);
        }
        if (!student && studentName) {
          student = students.find(s => s.name.toLowerCase() === studentName.toLowerCase());
        }

        if (!student) {
          results.failed++;
          results.errors.push({
            row: results.successful + results.failed,
            error: `Μαθητής δεν βρέθηκε: ${studentName || studentId}`,
            data: row
          });
          continue;
        }

        // Parse day of week
        const dayOfWeek = parseInt(row.day_of_week || row['day_of_week'] || row['Ημέρα']);
        if (isNaN(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 5) {
          results.failed++;
          results.errors.push({
            row: results.successful + results.failed,
            error: `Μη έγκυρη ημέρα εβδομάδας: ${row.day_of_week}`,
            data: row
          });
          continue;
        }

        // Get student addresses
        const { data: addresses } = await supabase
          .from('student_addresses')
          .select('*')
          .eq('student_id', student.id)
          .eq('is_active', true);

        // Find pickup address
        const pickupAddressName = row.pickup_address_name || row['pickup_address_name'] || row['Διεύθυνση Παραλαβής'];
        let pickupAddressId = null;
        if (pickupAddressName) {
          const pickupAddr = addresses?.find(addr => 
            addr.address_name?.toLowerCase() === pickupAddressName.toLowerCase() ||
            `${addr.street_name} ${addr.street_number}`.toLowerCase() === pickupAddressName.toLowerCase()
          );
          pickupAddressId = pickupAddr?.id;
        }

        // Find dropoff address
        const dropoffAddressName = row.dropoff_address_name || row['dropoff_address_name'] || row['Διεύθυνση Παράδοσης'];
        let dropoffAddressId = null;
        if (dropoffAddressName) {
          const dropoffAddr = addresses?.find(addr => 
            addr.address_name?.toLowerCase() === dropoffAddressName.toLowerCase() ||
            `${addr.street_name} ${addr.street_number}`.toLowerCase() === dropoffAddressName.toLowerCase()
          );
          dropoffAddressId = dropoffAddr?.id;
        }

        // Find pickup time slot
        const pickupTimeSlot = row.pickup_time_slot || row['pickup_time_slot'] || row['Ώρα Παραλαβής'];
        let pickupTimeSlotId = null;
        if (pickupTimeSlot) {
          const slot = timeSlots?.find(ts => 
            ts.slot_type === 'pickup' && (
              ts.slot_name.toLowerCase().includes(pickupTimeSlot.toLowerCase()) ||
              pickupTimeSlot.toLowerCase().includes(ts.slot_name.toLowerCase()) ||
              pickupTimeSlot.includes(ts.time_value?.substring(0, 5))
            )
          );
          pickupTimeSlotId = slot?.id;
        }

        // Find dropoff time slot
        const dropoffTimeSlot = row.dropoff_time_slot || row['dropoff_time_slot'] || row['Ώρα Παράδοσης'];
        let dropoffTimeSlotId = null;
        if (dropoffTimeSlot) {
          const slot = timeSlots?.find(ts => 
            ts.slot_type === 'dropoff' && (
              ts.slot_name.toLowerCase().includes(dropoffTimeSlot.toLowerCase()) ||
              dropoffTimeSlot.toLowerCase().includes(ts.slot_name.toLowerCase()) ||
              dropoffTimeSlot.includes(ts.time_value?.substring(0, 5))
            )
          );
          dropoffTimeSlotId = slot?.id;
        }

        // Create/update schedule
        const scheduleData = {
          student_id: student.id,
          day_of_week: dayOfWeek,
          pickup_address_id: pickupAddressId,
          pickup_time_slot_id: pickupTimeSlotId,
          dropoff_address_id: dropoffAddressId,
          dropoff_time_slot_id: dropoffTimeSlotId,
          notes: row.notes || row['notes'] || row['Σημειώσεις'] || '',
          is_active: true
        };

        const { error: scheduleError } = await supabase
          .from('student_weekly_schedules')
          .upsert(scheduleData);

        if (scheduleError) {
          results.failed++;
          results.errors.push({
            row: results.successful + results.failed,
            error: `Σφάλμα αποθήκευσης προγράμματος: ${scheduleError.message}`,
            data: row
          });
          continue;
        }

        results.successful++;

      } catch (error) {
        results.failed++;
        results.errors.push({
          row: results.successful + results.failed,
          error: error.message,
          data: row
        });
      }
    }

    logger.info('Schedule import completed', { 
      successful: results.successful, 
      failed: results.failed,
      userId: req.user.id 
    });

    res.json({
      message: 'Import completed',
      results
    });

  } catch (error) {
    logger.error('Import schedules error', { error: error.message });
    res.status(500).json({ error: 'Import failed' });
  } finally {
    if (filePath) {
      try {
        await fs.unlink(filePath);
      } catch (err) {
        logger.error('Failed to delete uploaded file', { error: err });
      }
    }
  }
});

module.exports = router;