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
    const csvData = students.map(student => ({
      'Όνομα': student.name,
      'Τάξη': student.grade,
      'Διεύθυνση': student.address,
      'Ιατρικές Πληροφορίες': student.medical_info || '',
      'Δευτερεύουσα Επαφή': student.emergency_contact || '',
      'Τηλέφωνο Δευτερεύουσας Επαφής': student.emergency_phone || '',
      'Email Γονέα': student.parent?.email || '',
      'Όνομα Γονέα': student.parent?.full_name || '',
      'Τηλέφωνο Γονέα': student.parent?.phone || '',
      'Στάση': student.stop?.name || '',
      'Διαδρομή': student.stop?.route?.name || '',
      'Ενεργός': student.is_active ? 'Ναι' : 'Όχι'
    }));

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
    const allowedFields = ['name', 'grade', 'address', 'medical_info', 'emergency_contact', 'emergency_phone', 'external_student_id', 'stop_id', 'is_active'];
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
        address,
        medical_info,
        emergency_contact,
        emergency_phone,
        is_active,
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
      address: student.address,
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
router.get('/route/:routeId/stop/:stopId', authenticateToken, authorizeRoles(['driver', 'admin', 'dispatcher']), async (req, res) => {
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
      home_address: student.address
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
        if (studentInfo.address) {
          const { error: addressError } = await supabase
            .from('student_addresses')
            .insert({
              student_id: createdStudent.id,
              address_type: 'primary',
              full_address: studentInfo.address,
              city: 'Αθήνα',
              is_active: true,
              is_pickup_address: true,
              is_dropoff_address: true,
              priority_order: 0
            });

          if (addressError) {
            logger.warn('Failed to create primary address for student during import', { 
              error: addressError, 
              studentId: createdStudent.id 
            });
            // Don't fail the import if address creation fails, just log it
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

    const { data, error } = await supabase
      .from('student_addresses')
      .insert({
        ...value,
        student_id: studentId
      })
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

    const { data, error } = await supabase
      .from('student_addresses')
      .update(value)
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

module.exports = router;