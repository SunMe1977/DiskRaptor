const fs = require('fs');
const app = fs.readFileSync('frontend/app.js', 'utf8');
console.log('isGalaxyMode:', app.includes('isGalaxyMode'));
console.log('selected:', app.includes('galaxyview:selected'));
console.log('loadData:', app.includes('galaxyView.loadData'));
console.log('updateLiveScan:', app.includes('galaxyView.updateLiveScan'));
const i18n = fs.readFileSync('frontend/i18n.js', 'utf8');
console.log('i18n galaxy:', i18n.includes('diagram.galaxy'));
