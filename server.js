require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const pdf = require("pdf-parse");
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

function toNotionText(value) {
  if (value == null || value === "") return "";

  if (typeof value === "string") {
    return value.trim().slice(0, 2000);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => toNotionText(item))
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000);
  }

  if (typeof value === "object") {
    const title = value.title || value.role || value.position || "";
    const company = value.company || value.organization || "";
    const duration = value.duration || value.dates || value.period || "";
    const description =
      value.description || value.summary || value.details || "";

    if (title || company) {
      const header = [title, company && `at ${company}`, duration && `(${duration})`]
        .filter(Boolean)
        .join(" ");
      const text = description ? `${header}: ${description}` : header;
      return text.slice(0, 2000);
    }

    return JSON.stringify(value).slice(0, 2000);
  }

  return String(value).slice(0, 2000);
}

function getTodayDate() {
  return new Date().toISOString().split("T")[0];
}

function toNotionPlace(location) {
  const text = toNotionText(location).trim();
  if (!text) return null;

  return {
    lat: 0,
    lon: 0,
    name: text,
    address: text
  };
}

async function extractCandidateFromResume(resumeText) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash"
  });

  const prompt = `
Extract candidate information from this resume.

Return ONLY JSON.

{
  "role":"",
  "place":"",
  "linkedin":"",
  "skills":[],
  "experience":"plain text summary of work history, NOT an array or object"
}

Important:
- place should be the candidate location (city, state, or country)
- experience must be a single plain text string
- skills must be an array of short strings only

Resume:

${resumeText}
`;

  const result = await model.generateContent(prompt);

  let responseText = result.response.text();

  responseText = responseText
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  return JSON.parse(responseText);
}

function buildCvFileName(originalName, candidateName) {
  const fromUpload = String(originalName || "").trim();
  if (fromUpload.toLowerCase().endsWith(".pdf")) {
    return fromUpload.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  }

  const fromCandidate = String(candidateName || "candidate")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);

  return `${fromCandidate || "candidate"}_CV.pdf`;
}

async function uploadCvToNotion(file, fileName) {
  const uploadMeta = await notion.fileUploads.create({
    mode: "single_part",
    filename: fileName,
    content_type: "application/pdf"
  });

  if (uploadMeta.status !== "pending") {
    throw new Error(`Notion file upload init failed: ${uploadMeta.status}`);
  }

  const pdfBlob = new Blob([file.buffer], { type: "application/pdf" });

  const sent = await notion.fileUploads.send({
    file_upload_id: uploadMeta.id,
    file: {
      data: pdfBlob,
      filename: fileName
    }
  });

  if (sent.status !== "uploaded") {
    throw new Error(`Notion file upload failed: ${sent.status}`);
  }

  return sent.id;
}

function isActiveNotionPage(page) {
  return !page.in_trash && !page.archived;
}

async function emailExists(email) {
  const response = await notion.dataSources.query({
    data_source_id: await getDataSourceId(),
    in_trash: false,
    filter: {
      property: "Email",
      email: { equals: email }
    }
  });
  return response.results.some(isActiveNotionPage);
}

async function phoneExists(phone) {
  const response = await notion.dataSources.query({
    data_source_id: await getDataSourceId(),
    in_trash: false,
    filter: {
      property: "Phone",
      phone_number: { equals: phone }
    }
  });
  return response.results.some(isActiveNotionPage);
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
      const employmentTypes = [
        "Self employed",
        "Freelancer",
        "Employee"
      ];
      const formEmploymentType = (req.body.employmentType || "").trim();

      if (!employmentTypes.includes(formEmploymentType)) {
        return res.status(400).json({
          success: false,
          field: "employmentType",
          error: "Please select an employment type."
        });
      }

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

      const candidate = {
        name: formName || "Unknown",
        email: formEmail || null,
        phone: formPhone || "",
        employmentType: formEmploymentType,
        role: "",
        place: "",
        linkedin: null,
        skills: [],
        experience: "",
        geminiUsed: false
      };

      try {
        const pdfData = await pdf(req.file.buffer);
        const resumeText = pdfData.text;

        if (!resumeText.trim()) {
          throw new Error("No text found in PDF.");
        }

        const extracted = await extractCandidateFromResume(resumeText);

        candidate.role = extracted.role || "";
        candidate.place = extracted.place || "";
        candidate.linkedin = extracted.linkedin || null;
        candidate.skills = extracted.skills || [];
        candidate.experience = extracted.experience || "";
        candidate.geminiUsed = true;
      } catch (extractError) {
        console.warn(
          "Resume extraction failed, saving form data only:",
          extractError.message
        );
      }

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

      const cvFileName = buildCvFileName(req.file.originalname, candidate.name);
      const cvFileUploadId = await uploadCvToNotion(req.file, cvFileName);

      const notionProperties = {
        Name: {
          title: [
            {
              text: {
                content: candidate.name
              }
            }
          ]
        },

        Email: {
          email: candidate.email
        },

        Phone: {
          phone_number: candidate.phone
        },

        "Employment type": {
          rich_text: [
            {
              text: {
                content: candidate.employmentType
              }
            }
          ]
        },

        Date: {
          date: {
            start: getTodayDate()
          }
        },

        Role: {
          rich_text: [
            {
              text: {
                content: toNotionText(candidate.role)
              }
            }
          ]
        },

        Experience: {
          rich_text: [
            {
              text: {
                content: toNotionText(candidate.experience)
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
              type: "file_upload",
              name: cvFileName,
              file_upload: {
                id: cvFileUploadId
              }
            }
          ]
        }
      };

      const place = toNotionPlace(candidate.place);
      if (place) {
        notionProperties.Place = { place };
      }

      const notionResponse = await notion.pages.create({
        parent: {
          database_id: process.env.DATABASE_ID
        },
        properties: notionProperties
      });

      res.json({
        success: true,
        candidate,
        geminiUsed: candidate.geminiUsed,
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
  const server = app.listen(port);

  server.on("listening", () => {
    console.log(`ATS Server running on http://localhost:${port}`);
    console.log(`Process ID: ${process.pid}`);
    console.log("Press Ctrl+C in this terminal to stop.");
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Another server is still running.`);
      console.error(`Find the PID: netstat -ano | findstr :${port}`);
      console.error(`Stop it: taskkill /PID <pid> /F`);
    } else {
      console.error("Server failed to start:", error.message);
    }
    process.exit(1);
  });
}

module.exports = app;
