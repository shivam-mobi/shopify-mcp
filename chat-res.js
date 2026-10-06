import fs from 'fs';

// chat-res.json has invalid JSON escapes like \& (only \\ \" \/ \b \f \n \r \t \uXXXX are valid)
const raw = fs.readFileSync('chat-res.json', 'utf8').replace(/\\&/g, '&');
const chatRes = JSON.parse(raw);

// Prefer structuredContent (already an object); fall back to parsing content[0].text
const parseData =
  chatRes.result.structuredContent ??
  JSON.parse(chatRes.result.content[0].text);

fs.writeFileSync('chat-parsed-data.json', JSON.stringify(parseData, null, 2));
console.log('Wrote chat-parsed-data.json');
