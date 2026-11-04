const express = require('express');
const app = express();
app.get('/', (_req, res) => res.send('DevFlow Node fixture'));
app.listen(Number(process.env.PORT), '0.0.0.0');
