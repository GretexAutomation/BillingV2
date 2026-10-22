const fs = require('fs');
let content = fs.readFileSync('biller.html', 'utf8');

const marker1 = content.indexOf('//   isSubmitting: false,');
const marker2 = content.lastIndexOf('  isSubmitting: false,');

if (marker1 !== -1 && marker2 !== -1 && marker1 < marker2) {
  content = content.substring(0, marker1) + content.substring(marker2);
  fs.writeFileSync('biller.html', content, 'utf8');
  console.log('Successfully cleaned garbage from biller.html!');
} else {
  console.log('Markers not found or invalid: marker1=' + marker1 + ', marker2=' + marker2);
}
