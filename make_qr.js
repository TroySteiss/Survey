const QRCode = require('qrcode');
const url = 'https://giveaway-survey-production.up.railway.app/';
QRCode.toFile('public/qr.svg', url, { type: 'svg', errorCorrectionLevel: 'H', margin: 2, color: { dark: '#0f2440', light: '#ffffff' } })
  .then(() => QRCode.toFile('giveaway-qr.png', url, { errorCorrectionLevel: 'H', margin: 2, width: 1200, color: { dark: '#0f2440', light: '#ffffff' } }))
  .then(() => console.log('done'));
