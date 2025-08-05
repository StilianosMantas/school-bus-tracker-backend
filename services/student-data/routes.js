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

const logger = createServiceLogger('student-data-service');

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
  address: Joi.string().max(200).required(),
  medical_info: Joi.string().max(500).allow('', null),
  parent_email: Joi.string().email().required(),
  parent_name: Joi.string().min(2).max(100).required(),
  parent_phone: Joi.string().pattern(/^(\+30)?[0-9]{10}$/).required(),
  stop_id: Joi.string().uuid().optional()
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
        stop:stops(*)
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

    // Create parent if doesn't exist
    if (!parent) {
      // Create auth user
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: parent_email,
        password: Math.random().toString(36).slice(-12), // Random password
        email_confirm: true,
        user_metadata: {
          full_name: parent_name
        }
      });

      if (authError) {
        logger.error('Failed to create parent auth', { error: authError });
        return res.status(500).json({ error: 'Failed to create parent account' });
      }

      // Create profile
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: authData.user.id,
          email: parent_email,
          full_name: parent_name,
          phone: parent_phone,
          role: 'parent'
        })
        .select()
        .single();

      if (profileError) {
        logger.error('Failed to create parent profile', { error: profileError });
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

    res.status(201).json({ data: student });
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
    const allowedFields = ['name', 'grade', 'address', 'medical_info', 'stop_id'];
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

// Get students by stop (Driver/Admin only)
router.get('/stop/:stopId', authenticateToken, authorizeRoles(['driver', 'admin', 'dispatcher']), async (req, res) => {
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

        // Process parent
        const { parent_email, parent_name, parent_phone, ...studentInfo } = value;

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
            password: Math.random().toString(36).slice(-12),
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

          // Create profile
          const { data: profileData, error: profileError } = await supabase
            .from('profiles')
            .insert({
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
        const { error: studentError } = await supabase
          .from('students')
          .insert({
            ...studentInfo,
            parent_id: parent.id
          });

        if (studentError) {
          results.failed++;
          results.errors.push({
            row: results.successful + results.failed,
            error: 'Failed to create student',
            data: studentData
          });
          continue;
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
router.post('/attendance/batch', authenticateToken, authorizeRoles(['driver']), async (req, res) => {
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
      'Όνομα': 'Μαρία Παπαδοπούλου',
      'Τάξη': 'Δ΄ Δημοτικού',
      'Διεύθυνση': 'Πατησίων 45, Αθήνα',
      'Ιατρικές Πληροφορίες': 'Αλλεργία στα φιστίκια',
      'Email Γονέα': 'parent1@example.com',
      'Όνομα Γονέα': 'Γιώργος Παπαδόπουλος',
      'Τηλέφωνο Γονέα': '+306912345678'
    },
    {
      'Όνομα': 'Νίκος Γεωργίου',
      'Τάξη': 'Ε΄ Δημοτικού',
      'Διεύθυνση': 'Σταδίου 10, Αθήνα',
      'Ιατρικές Πληροφορίες': '',
      'Email Γονέα': 'parent2@example.com',
      'Όνομα Γονέα': 'Ελένη Γεωργίου',
      'Τηλέφωνο Γονέα': '6923456789'
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
router.get('/:studentId', authenticateToken, authorizeRoles(['parent', 'admin', 'driver']), async (req, res) => {
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

module.exports = router;