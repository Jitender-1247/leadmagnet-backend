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
// Middleware
app.use(logger('dev'));
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true // Allow cookies or auth headers if needed
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
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