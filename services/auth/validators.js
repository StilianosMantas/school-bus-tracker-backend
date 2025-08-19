const Joi = require('joi');

// Validation schemas
const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required()
});

const signupSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  fullName: Joi.string().min(2).max(100).required(),
  role: Joi.string().valid('parent', 'driver', 'admin', 'dispatcher', 'escort').required(),
  phone: Joi.string().pattern(/^(\+30)?[0-9]{10}$/).optional(),
  // Address fields (required for drivers and escorts)
  street_address: Joi.string().when('role', {
    is: Joi.string().valid('driver', 'escort'),
    then: Joi.required(),
    otherwise: Joi.optional()
  }),
  city: Joi.string().default('Αθήνα').optional(),
  postal_code: Joi.string().when('role', {
    is: Joi.string().valid('driver', 'escort'),
    then: Joi.required(),
    otherwise: Joi.optional()
  }),
  country: Joi.string().default('Ελλάδα').optional()
});

// Validation middleware
const validateLogin = (req, res, next) => {
  const { error } = loginSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ 
      error: error.details[0].message 
    });
  }
  next();
};

const validateSignup = (req, res, next) => {
  const { error } = signupSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ 
      error: error.details[0].message 
    });
  }
  next();
};

module.exports = {
  validateLogin,
  validateSignup
};