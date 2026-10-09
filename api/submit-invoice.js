// ===========================================================================
// api/submit-invoice.js — Vercel Serverless Function
// Invoice Intake, AI 54-Point Extraction & Google Drive/Sheet Sync
// ===========================================================================

const { google } = require("googleapis");
const { Readable } = require("stream");

// Increase Vercel request body size limit for PDFs / Images
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

// ─────────────────────────────────────────────
// 1. Google Auth Helper (Service Account)
// ─────────────────────────────────────────────
function getGoogleAuth() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY || "";
  
  // Fix escaped newlines if passed from env
  privateKey = privateKey.replace(/\\n/g, "\n");

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });
}

// ─────────────────────────────────────────────
// 2. Gemini Multi-Key Failover
// ─────────────────────────────────────────────
function getGeminiApiKeys() {
  const raw = process.env.GEMINI_API_KEY || "";
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

async function callGeminiWithFailover(parts) {
  const apiKeys = getGeminiApiKeys();
  if (apiKeys.length === 0) {
    throw new Error("No GEMINI_API_KEY configured in Environment Variables.");
  }

  const MAX_ROUNDS = 2;
  let lastError = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    for (let i = 0; i < apiKeys.length; i++) {
      const apiKey = apiKeys[i];
      try {
        console.log(`[Gemini] Attempting with Key index ${i} (Round ${round + 1})...`);
        const result = await callGeminiAPI(parts, apiKey);
        return result;
      } catch (err) {
        lastError = err.message;
        console.warn(`[Gemini] Key index ${i} failed: ${err.message}`);
        // If rate limited or quota exceeded, continue to next key
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (round < MAX_ROUNDS - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  throw new Error(`All Gemini API keys exhausted. Last error: ${lastError}`);
}

async function callGeminiAPI(parts, apiKey) {
  // Try 2.0 Flash or 1.5 Flash
  const model = "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: parts }],
    generationConfig: {
      responseMimeType: "application/json",
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();

  if (!response.ok) {
    let errMessage = `HTTP ${response.status}`;
    try {
      const errObj = JSON.parse(responseText);
      if (errObj?.error?.message) errMessage += `: ${errObj.error.message}`;
    } catch (_) {
      errMessage += `: ${responseText.substring(0, 150)}`;
    }
    throw new Error(errMessage);
  }

  const jsonResp = JSON.parse(responseText);
  const candidate = jsonResp.candidates?.[0];
  if (!candidate?.content?.parts?.[0]) {
    const reason = candidate?.finishReason || "NO_CANDIDATES";
    throw new Error(`AI returned no content (Reason: ${reason})`);
  }

  let text = candidate.content.parts[0].text;
  text = text.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  return JSON.parse(text);
}

// ─────────────────────────────────────────────
// 3. Gemini Prompt (54 Points)
// ─────────────────────────────────────────────
function getGeminiPrompt(details) {
  return `You are an expert accountant. Analyze this invoice for Gretex.
Submission Details: From ${details.receivedFrom || "Manual Upload"}, Notes: ${details.notes || "None"}.

Extract the data and return a STRICT JSON object matching these exact keys. 
If a value is missing or cannot be determined, write 'N/A'.
IMPORTANT: For A10, A7, B3, C3 (GST/PAN numbers), return ONLY alphanumeric characters. NEVER start with '+' or '='.

{
  "A1": "<Billed To Co Name>",
  "A2": "<Our Name Correct (Yes/No)>",
  "A3": "<Address Present (Yes/No)>",
  "A4": "<Our Address>",
  "A5": "<Address Correct (Yes/No)>",
  "A6": "<Our PAN Present (Yes/No)>",
  "A7": "<Our PAN>",
  "A8": "<PAN Correct (Yes/No)>",
  "A9": "<Our GST Present (Yes/No)>",
  "A10": "<Our GST>",
  "A11": "<GST Correct (Yes/No)>",
  "A12": "<Invoice Date>",
  "A13": "<Invoice Number>",
  "A14": "<Vendor Name>",
  "A15": "<Vendor Address>",
  "A16": "<Description>",
  "A17": "<Notes>",
  "A18": "<Rev/Capital>",
  "A19": "<Ledger Name>",
  "A20": "<Basic Amt (Number)>",
  "A21": "<Invoice Type>",
  "A22": "<Final Invoice By>",
  "A23": "<First Time Vendor (Yes/No)>",
  "A24": "<Amt Justified (Yes/No)>",
  "B1": "<TDS App (Yes/No)>",
  "B2": "<Vendor PAN Avail (Yes/No)>",
  "B3": "<Vendor PAN>",
  "B4": "<PAN Inoperative (Yes/No)>",
  "B5": "<Entity Type>",
  "B6": "<TDS Section>",
  "B7": "<TDS Rate>",
  "B8": "<TDS Amt (Number)>",
  "C1": "<GST Charged (Yes/No)>",
  "C2": "<Vendor GST Avail (Yes/No)>",
  "C3": "<Vendor GST No>",
  "C4": "<Taxpayer Type>",
  "C5": "<Comp GST Wrong>",
  "C6": "<GST Returns Filed>",
  "C7": "<Our GST Correct>",
  "C8": "<Place of Supply>",
  "C9": "<Correct GST Type (Yes/No)>",
  "C10": "<Prior GST Pending>",
  "C11": "<Blocked Credit>",
  "D1": "<Final Payable (Number)>",
  "D2": "<Provided By>",
  "D3": "<Received Via>",
  "D4": "<HOD Name>",
  "D5": "<HOD Approval>",
  "D6": "<HOD Screenshot>",
  "D7": "<Arvind/Alok Apprvl>",
  "D8": "<Arvind/Alok SS>",
  "D9": "<Update Person>",
  "D10": "<Update Email>",
  "D11": "<Narration>",
  "redFlags": ["<issue 1>", "<issue 2>"], 
  "overallStatus": "<PASS, REVIEW, or FAIL>"
}`;
}

// ─────────────────────────────────────────────
// 4. Save to Google Drive
// ─────────────────────────────────────────────
async function uploadToDrive(auth, fileBuffer, fileName, fileType) {
  const folderId = process.env.UPLOAD_FOLDER_ID;
  const drive = google.drive({ version: "v3", auth });

  const stream = new Readable();
  stream.push(fileBuffer);
  stream.push(null);

  const requestBody = {
    name: fileName,
  };
  if (folderId) {
    requestBody.parents = [folderId];
  }

  const res = await drive.files.create({
    requestBody,
    media: {
      mimeType: fileType,
      body: stream,
    },
    fields: "id, webViewLink",
  });

  return res.data.webViewLink || `https://drive.google.com/file/d/${res.data.id}/view`;
}

// ─────────────────────────────────────────────
// 5. Append to Google Sheets
// ─────────────────────────────────────────────
async function appendToSheet(auth, ai, driveUrl, senderEmail, fileName) {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) {
    throw new Error("SHEET_ID is missing in environment variables.");
  }

  const sheets = google.sheets({ version: "v4", auth });

  // Format date time: DD-MM-YYYY HH:mm:ss
  const now = new Date();
  const d = String(now.getDate()).padStart(2, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const y = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const formattedTime = `${d}-${m}-${y} ${hh}:${mm}:${ss}`;

  const clean = (val) => {
    if (val === undefined || val === null) return "";
    let s = String(val).trim();
    if (s.startsWith("+") || s.startsWith("=") || s.startsWith("-")) return "'" + s;
    return s;
  };

  const row = [
    formattedTime, clean(senderEmail), "Manual Submission", clean(fileName), driveUrl,
    clean(ai.A1), clean(ai.A2), clean(ai.A3), clean(ai.A4), clean(ai.A5),
    clean(ai.A6), clean(ai.A7), clean(ai.A8), clean(ai.A9), clean(ai.A10),
    clean(ai.A11), clean(ai.A12), clean(ai.A13), clean(ai.A14), clean(ai.A15),
    clean(ai.A16), clean(ai.A17), clean(ai.A18), clean(ai.A19), ai.A20 || 0,
    clean(ai.A21), clean(ai.A22), clean(ai.A23), clean(ai.A24),
    clean(ai.B1), clean(ai.B2), clean(ai.B3), clean(ai.B4), clean(ai.B5),
    clean(ai.B6), clean(ai.B7), ai.B8 || 0,
    clean(ai.C1), clean(ai.C2), clean(ai.C3), clean(ai.C4), clean(ai.C5),
    clean(ai.C6), clean(ai.C7), clean(ai.C8), clean(ai.C9), clean(ai.C10), clean(ai.C11),
    ai.D1 || 0, clean(ai.D2), clean(ai.D3), clean(ai.D4), clean(ai.D5),
    clean(ai.D6), clean(ai.D7), clean(ai.D8), clean(ai.D9), clean(ai.D10), clean(ai.D11),
    (Array.isArray(ai.redFlags) ? ai.redFlags : []).join(" | "),
    clean(ai.overallStatus), "New"
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Invoices!A:BJ",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [row],
    },
  });
}

// ─────────────────────────────────────────────
// 6. Main Serverless Handler
// ─────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed. Use POST." });
  }

  try {
    const {
      fileName,
      fileType,
      fileContent,
      receivedFrom,
      receivedDate,
      senderName,
      notes,
      billerEmail,
    } = req.body;

    if (!fileName || !fileContent) {
      return res.status(400).json({ success: false, message: "Missing fileName or fileContent." });
    }

    // 1. Clean Base64
    let pureBase64 = fileContent;
    if (pureBase64.indexOf(",") > -1) {
      pureBase64 = pureBase64.split(",")[1];
    }
    const fileBuffer = Buffer.from(pureBase64, "base64");

    // 2. Authenticate Google Client
    console.log("Authenticating with Google Service Account...");
    const auth = getGoogleAuth();

    // 3. Upload File to Google Drive
    console.log(`Uploading ${fileName} to Google Drive...`);
    let driveUrl = "";
    try {
      driveUrl = await uploadToDrive(auth, fileBuffer, fileName, fileType || "application/pdf");
      console.log(`Uploaded to Drive: ${driveUrl}`);
    } catch (driveErr) {
      console.warn("Drive upload warning:", driveErr.message);
      driveUrl = "Drive Upload Failed: " + driveErr.message;
    }

    // 4. Call Gemini AI with Failover
    console.log("Analyzing invoice with Gemini AI...");
    const prompt = getGeminiPrompt({ receivedFrom, notes });
    const parts = [
      { text: prompt },
      {
        inlineData: {
          mimeType: fileType || "application/pdf",
          data: pureBase64,
        },
      },
    ];

    const aiData = await callGeminiWithFailover(parts);
    console.log("Gemini extraction complete:", aiData.A13, aiData.A14);

    // 5. Append Row to Google Sheets ('Invoices' tab)
    console.log("Appending row to Google Sheets...");
    await appendToSheet(auth, aiData, driveUrl, billerEmail || senderName || "Manual Upload", fileName);

    // 6. Return Success Response
    return res.status(200).json({
      success: true,
      message: "Invoice successfully processed and recorded!",
      data: {
        invoiceNumber: aiData.A13 || "N/A",
        vendorName: aiData.A14 || "N/A",
        basicAmount: aiData.A20 || 0,
        overallStatus: aiData.overallStatus || "REVIEW",
        redFlags: aiData.redFlags || [],
        driveUrl,
      },
    });

  } catch (error) {
    console.error("Handler error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to process invoice.",
    });
  }
}
