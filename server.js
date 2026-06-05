require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const pdf = require("pdf-parse");
const cloudinary = require("cloudinary").v2;
const { Client } = require("@notionhq/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const notion = new Client({
  auth: process.env.NOTION_TOKEN
});

const genAI = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY
);

if (!process.env.CLOUDINARY_URL) {
  console.warn("Warning: CLOUDINARY_URL is missing. CV uploads will fail.");
} else {
  cloudinary.config({ secure: true });
}

let dataSourceId = null;

async function getDataSourceId() {
  if (dataSourceId) return dataSourceId;

  const database = await notion.databases.retrieve({
    database_id: process.env.DATABASE_ID
  });

  if (!database.data_sources?.length) {
    throw new Error("No data source found for the configured database.");
  }

  dataSourceId = database.data_sources[0].id;
  return dataSourceId;
}

function normalizeSkills(skills) {
  return (skills || [])
    .flatMap((skill) =>
      String(skill)
        .split(",")
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter(Boolean)
    )
    .map((skill) => skill.slice(0, 100));
}

async function uploadToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "raw",
        folder: "cvs"
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(file.buffer);
  });
}

async function emailExists(email) {
  const response = await notion.dataSources.query({
    data_source_id: await getDataSourceId(),
    filter: {
      property: "Email",
      email: { equals: email }
    }
  });
  return response.results.length > 0;
}

async function phoneExists(phone) {
  const response = await notion.dataSources.query({
    data_source_id: await getDataSourceId(),
    filter: {
      property: "Phone",
      phone_number: { equals: phone }
    }
  });
  return response.results.length > 0;
}

app.get("/check-unique", async (req, res) => {
  try {
    const { email, phone } = req.query;

    if (email) {
      const exists = await emailExists(email);
      return res.json({ unique: !exists, field: "email" });
    }

    if (phone) {
      const exists = await phoneExists(phone);
      return res.json({ unique: !exists, field: "phone" });
    }

    res.status(400).json({
      unique: false,
      error: "Provide email or phone query parameter."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      unique: false,
      error: error.message
    });
  }
});

app.post(
  "/submit",
  upload.single("cv"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "CV file is required."
        });
      }

      const formEmail = (req.body.email || "").trim();
      const formPhone = (req.body.phone || "").trim();
      const formName = (req.body.name || "").trim();

      if (formEmail && await emailExists(formEmail)) {
        return res.status(409).json({
          success: false,
          field: "email",
          error: "This email is already registered."
        });
      }

      if (formPhone && await phoneExists(formPhone)) {
        return res.status(409).json({
          success: false,
          field: "phone",
          error: "This phone number is already registered."
        });
      }

      const pdfData = await pdf(req.file.buffer);
      const resumeText = pdfData.text;

      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash"
      });

      const prompt = `
Extract candidate information.

Return ONLY JSON.

{
  "name":"",
  "email":"",
  "phone":"",
  "role":"",
  "linkedin":"",
  "skills":[],
  "experience":""
}

Resume:

${resumeText}
`;

      const result = await model.generateContent(prompt);

      let responseText = result.response.text();

      responseText = responseText
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();

      const candidate = JSON.parse(responseText);

      if (formName) candidate.name = formName;
      if (formEmail) candidate.email = formEmail;
      if (formPhone) candidate.phone = formPhone;

      const finalEmail = (candidate.email || "").trim();
      const finalPhone = (candidate.phone || "").trim();

      if (finalEmail && await emailExists(finalEmail)) {
        return res.status(409).json({
          success: false,
          field: "email",
          error: "This email is already registered."
        });
      }

      if (finalPhone && await phoneExists(finalPhone)) {
        return res.status(409).json({
          success: false,
          field: "phone",
          error: "This phone number is already registered."
        });
      }

      console.log(candidate);

      const uploadResult = await uploadToCloudinary(req.file);
      const fileUrl = uploadResult.secure_url;

      const notionResponse = await notion.pages.create({
        parent: {
          database_id: process.env.DATABASE_ID
        },

        properties: {
          Name: {
            title: [
              {
                text: {
                  content: candidate.name || "Unknown"
                }
              }
            ]
          },

          Email: {
            email: candidate.email || null
          },

          Phone: {
            phone_number: candidate.phone || ""
          },

          Role: {
            rich_text: [
              {
                text: {
                  content: candidate.role || ""
                }
              }
            ]
          },

          Experience: {
            rich_text: [
              {
                text: {
                  content: candidate.experience || ""
                }
              }
            ]
          },

          LinkedIn: {
            url: candidate.linkedin || null
          },

          Skills: {
            multi_select: normalizeSkills(candidate.skills).map(skill => ({
              name: skill
            }))
          },

          Status: {
            status: {
              name: "Not started"
            }
          },

          cv: {
            files: [
              {
                name: req.file.originalname,
                external: {
                  url: fileUrl
                }
              }
            ]
          }
        }
      });

      res.json({
        success: true,
        candidate,
        notionPageId: notionResponse.id
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

if (require.main === module) {
  const port = process.env.PORT || 5000;
  const server = app.listen(port, () => {
    console.log(`ATS Server running on http://localhost:${port}`);
    console.log(`Process ID: ${process.pid}`);
    console.log("Press Ctrl+C in this terminal to stop.");
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use. Another server is still running.`
      );
      console.error(
        `Stop it with: taskkill /PID <pid> /F`
      );
      console.error(
        `Find the PID with: netstat -ano | findstr :${port}`
      );
    } else {
      console.error("Server failed to start:", error.message);
    }
    process.exit(1);
  });
}

module.exports = app;
