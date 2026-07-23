AI-DNA VERIFIED YAHOO FIX

Upload these items to the ROOT of the GitHub repository:
1. index.html
2. the entire api folder (containing api/yahoo.js)
3. vercel.json

Correct repository layout:
/index.html
/vercel.json
/api/yahoo.js

The old yahoo.js file sitting beside index.html is unnecessary. It may be deleted later.

After GitHub commits the files, wait for Vercel to show Ready. Then test:
https://ai-dna-mu.vercel.app/api/yahoo?symbol=NVDA

The endpoint should return JSON. Then hard-refresh the main site with Ctrl+F5.
