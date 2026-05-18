var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');
var dotenv = require('dotenv');
dotenv.config();

var indexRouter = require('./routes/index');
var scheduler = require('./services/Scheduler');
var app = express();
app.set('trust proxy', 1);

const allowedOrigins = [
  'https://cloudflare-workers-autoconfig-leadmagnet.jitenderkumar1208733.workers.dev'
];
// 1. Define CORS options with a custom origin function
const corsOptions = {
  origin: function (origin, callback) {
    // Allow local development or tool testing (like Postman) where origin is undefined
    if (!origin) return callback(null, true);
    
    // Check if the exact frontend domain is in our list
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked for origin: ${origin}`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200 // Explicitly forces older browsers/proxies to accept a 200 on preflight
};

// 2. Apply CORS to all routes
app.use(cors(corsOptions));

// 3. EXPLICITLY handle preflight (OPTIONS) requests globally
app.options('*', cors(corsOptions));
// 4. Continue with other middleware and routes
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/campaigns', require('./routes/campaign'));
app.use('/api/v1/inbox', require('./routes/inbox'));
app.use('/api/v1/analytics', require('./routes/analytics'));
app.use('/api/v1/user', require('./routes/user'));

app.use('/', indexRouter);

// ✅ Start scheduler (add this line)
scheduler.init();

// View engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// 404 handler
app.use(function(req, res, next) {
  next(createError(404));
});

// Error handler
app.use(function(err, req, res, next) {
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;