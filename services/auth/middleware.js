const { supabase, supabasePublic } = require('../../shared/database/supabase');
const { createServiceLogger } = require('../../shared/logger');

const logger = createServiceLogger('auth-middleware');

// Authenticate JWT token
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);
    
    // Token verification (verbose logging disabled)
    
    // Verify token with Supabase
    const { data: { user }, error } = await supabasePublic.auth.getUser(token);
    
    if (error || !user) {
      logger.error('Token verification failed', { 
        error: error?.message,
        errorCode: error?.code,
        hasUser: !!user,
        tokenLength: token.length
      });
      return res.status(401).json({ error: 'Invalid token' });
    }

    // JWT user extracted successfully

    // Get user profile with role (use service key to bypass RLS)
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError) {
      logger.error('Profile fetch failed in auth', { userId: user.id, error: profileError });
      return res.status(500).json({ error: 'Failed to fetch user profile' });
    }

    // Attach user to request
    req.user = {
      id: user.id,
      email: user.email,
      role: profile?.role || 'parent',
      fullName: profile?.full_name,
      phone: profile?.phone
    };

    next();
  } catch (error) {
    logger.error('Auth middleware error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Authorize based on roles
const authorizeRoles = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      logger.warn('Unauthorized role access', { 
        userId: req.user.id, 
        userRole: req.user.role, 
        requiredRoles: allowedRoles 
      });
      return res.status(403).json({ error: 'Forbidden' });
    }

    next();
  };
};

// Optional authentication - doesn't fail if no token
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);
    const { data: { user }, error } = await supabasePublic.auth.getUser(token);
    
    if (!error && user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      req.user = {
        id: user.id,
        email: user.email,
        role: profile?.role || 'parent',
        fullName: profile?.full_name,
        phone: profile?.phone
      };
    }

    next();
  } catch (error) {
    logger.error('Optional auth error', { error: error.message });
    next();
  }
};

module.exports = {
  authenticateToken,
  authorizeRoles,
  optionalAuth
};