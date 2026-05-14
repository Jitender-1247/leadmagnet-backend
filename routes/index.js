require('dotenv').config();
var express = require('express');
var app = express.Router();

/* GET home page. */
app.get('/', function(req, res, next) {
  res.send('Welcome to the LinkedIn Outreach Automation API');
});



module.exports = app;