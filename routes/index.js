var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Express Hellooo!' });
});

router.get('/test', function(req, res, next) {
  res.render('index', { title: 'Render Test!!' });
});

module.exports = router;
