import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import ExcelJS from "exceljs";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const environment = process.env.NODE_ENV || "development";
const isProduction = environment === "production";
const port = Number(process.env.PORT) || 4173;
const dataDirectory = process.env.DATA_DIRECTORY || path.join(__dirname, "data");
const developmentOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173"]);
const allowedOrigins = isProduction ? new Set([process.env.FRONTEND_ORIGIN]) : developmentOrigins;
const recordsPath = path.join(dataDirectory, "mori-records.json");
const workbookPath = path.join(dataDirectory, "mori-requests.xlsx");
let writeQueue = Promise.resolve();
let workbookPending = false;

if (isProduction) {
  const missingVariables = ["ADMIN_API_TOKEN", "FRONTEND_ORIGIN", "DATA_DIRECTORY"].filter((name) => !process.env[name]);
  if (missingVariables.length) {
    throw new Error(`Missing required production environment variables: ${missingVariables.join(", ")}`);
  }
  if (!process.env.FRONTEND_ORIGIN.startsWith("https://") || !path.isAbsolute(dataDirectory)) {
    throw new Error("FRONTEND_ORIGIN must use HTTPS and DATA_DIRECTORY must be an absolute path in production.");
  }
}

const menu = new Map([
  ["mori-stack", { name: "The Mori Stack", price: 18 }],
  ["garden-stack", { name: "Garden Stack", price: 15 }],
  ["sunrise-bun", { name: "Sunrise Bun", price: 13 }],
  ["crisp-potatoes", { name: "Crisp Potatoes", price: 7 }],
]);

const bookingHeaders = ["Booking ID", "Received at", "Name", "Email", "Guests", "Date", "Time", "Status"];
const orderHeaders = ["Order ID", "Received at", "Customer", "Phone", "Fulfillment", "Items", "Total", "Notes", "Status"];
const updatesHeaders = ["Type", "ID", "Received at", "Customer", "Contact", "Guests", "Date", "Time", "Fulfillment", "Items", "Total", "Notes", "Status"];

function sendApiError(request, response, status, message) {
  response.status(status).json({ message, requestId: request.correlationId });
}

function reportServerError(request, error) {
  console.error(JSON.stringify({ requestId: request.correlationId, errorName: error.name, errorMessage: error.message }));
}

function rateLimitHandler(request, response) {
  sendApiError(request, response, 429, "Too many requests. Try again later.");
}

const publicWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: rateLimitHandler,
});

const privacyDeleteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: rateLimitHandler,
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: rateLimitHandler,
});

app.disable("x-powered-by");
app.use((request, response, next) => {
  request.correlationId = randomBytes(12).toString("hex");
  response.setHeader("X-Request-ID", request.correlationId);
  next();
});
app.use(helmet({
  frameguard: { action: "deny" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
    },
  },
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
}));
app.use("/api", (request, response, next) => {
  const origin = request.get("origin");
  if (origin && !allowedOrigins.has(origin)) {
    return sendApiError(request, response, 403, "Origin is not allowed.");
  }
  return next();
});
app.use("/api", cors({
  origin: true,
  credentials: false,
  methods: ["GET", "POST"],
}));
app.use(express.json({ limit: "32kb" }));

function cleanText(value, field, maxLength = 120) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text || text.length > maxLength || /^[=+\-@]/.test(text)) {
    throw new Error(`Please provide a valid ${field}.`);
  }
  return text;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00`));
}

function cleanOptionalText(value, field, maxLength = 300) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (text.length > maxLength || /^[=+\-@]/.test(text)) {
    throw new Error(`Please provide valid ${field}.`);
  }
  return text;
}

function isValidationError(error) {
  return error.message.startsWith("Please ") || error.message.startsWith("Add ") || error.message.startsWith("Your order");
}

function hashPrivacyCode(code) {
  return createHash("sha256").update(code).digest("hex");
}

function createPrivacyCode() {
  return randomBytes(12).toString("hex");
}

function hasValidAdminToken(request) {
  const expected = process.env.ADMIN_API_TOKEN;
  const supplied = request.get("x-admin-token");
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function requireAdmin(request, response, next) {
  if (!hasValidAdminToken(request)) {
    sendApiError(request, response, 403, "Administrator authorization is required.");
    return;
  }
  next();
}

async function readRecords() {
  const exists = await fs.stat(recordsPath).then(() => true).catch(() => false);
  if (!exists) return { bookings: [], orders: [] };
  return JSON.parse(await fs.readFile(recordsPath, "utf8"));
}

async function saveRecord(type, record) {
  const nextWrite = writeQueue.then(async () => {
    await fs.mkdir(dataDirectory, { recursive: true });
    const records = await readRecords();
    records[type].push(record);
    await fs.writeFile(recordsPath, JSON.stringify(records, null, 2), "utf8");
    return refreshWorkbookCopy();
  });
  writeQueue = nextWrite.catch(() => {});
  return nextWrite;
}

async function createWorkbook() {
  const records = await readRecords();
  const workbook = new ExcelJS.Workbook();
  workbook.views = [{ activeTab: 0 }];
  const updates = ensureSheet(workbook, "All Entries", updatesHeaders, [14, 17, 27, 24, 30, 10, 15, 12, 16, 46, 14, 38, 15]);
  const bookings = ensureSheet(workbook, "Bookings", bookingHeaders, [16, 27, 24, 30, 10, 15, 12, 15]);
  const orders = ensureSheet(workbook, "Orders", orderHeaders, [16, 27, 24, 18, 16, 46, 14, 38, 15]);
  const allEntries = [
    ...records.bookings.map((record) => ({ type: "Booking", record })),
    ...records.orders.map((record) => ({ type: "Order", record })),
  ].sort((first, second) => second.record.receivedAt.localeCompare(first.record.receivedAt));
  allEntries.forEach(({ type, record }) => {
    const row = type === "Booking"
      ? updates.addRow([type, record.id, record.receivedAt, record.name, record.email, record.guests, record.date, record.time, "", "", "", "", record.status])
      : updates.addRow([type, record.id, record.receivedAt, record.customer, record.phone, "", "", "", record.fulfillment, record.items, record.total, record.notes, record.status]);
    if (type === "Order") row.getCell(11).numFmt = "$0.00";
  });
  records.bookings.forEach((record) => bookings.addRow([record.id, record.receivedAt, record.name, record.email, record.guests, record.date, record.time, record.status]));
  records.orders.forEach((record) => {
    const row = orders.addRow([record.id, record.receivedAt, record.customer, record.phone, record.fulfillment, record.items, record.total, record.notes, record.status]);
    row.getCell(7).numFmt = "$0.00";
  });
  return workbook;
}

async function refreshWorkbookCopy() {
  const workbook = await createWorkbook();
  try {
    await workbook.xlsx.writeFile(workbookPath);
    workbookPending = false;
    return true;
  } catch (error) {
    if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
    workbookPending = true;
    return false;
  }
}

function ensureSheet(workbook, name, headers, widths) {
  const sheet = workbook.getWorksheet(name) || workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  if (sheet.rowCount === 0) {
    const header = sheet.addRow(headers);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C2018" } };
    header.alignment = { vertical: "middle" };
    sheet.columns = widths.map((width) => ({ width }));
  }
  return sheet;
}

app.get("/api/health", (_request, response) => response.json({ ok: true }));

app.get("/api/entry-count", async (_request, response) => {
  try {
    const records = await readRecords();
    response.json({ bookingCount: records.bookings.length, orderCount: records.orders.length });
  } catch (error) {
    reportServerError(_request, error);
    sendApiError(_request, response, 500, "Could not load entry counts. Try again shortly.");
  }
});

app.post("/api/reset", adminLimiter, requireAdmin, async (_request, response) => {
  const nextWrite = writeQueue.then(async () => {
    await fs.mkdir(dataDirectory, { recursive: true });
    await fs.writeFile(recordsPath, JSON.stringify({ bookings: [], orders: [] }, null, 2), "utf8");
    await refreshWorkbookCopy();
  });
  writeQueue = nextWrite.catch(() => {});

  try {
    await nextWrite;
    response.json({ message: "Bookings and orders reset." });
  } catch (error) {
    reportServerError(_request, error);
    sendApiError(_request, response, 500, "Could not reset entries. Try again shortly.");
  }
});

app.post("/api/bookings", publicWriteLimiter, async (request, response) => {
  try {
    const name = cleanText(request.body.name, "name");
    const email = cleanText(request.body.email, "email");
    const guests = Number(request.body.guests);
    const date = String(request.body.date ?? "");
    const time = String(request.body.time ?? "");
    if (!/^\S+@\S+\.\S+$/.test(email) || !Number.isInteger(guests) || guests < 1 || guests > 20 || !validDate(date) || !/^\d{2}:\d{2}$/.test(time)) {
      throw new Error("Please complete every booking field with valid details.");
    }

    const bookingId = `BK-${Date.now()}`;
    const receivedAt = new Date().toISOString();
    const privacyCode = createPrivacyCode();
    const workbookUpdated = await saveRecord("bookings", {
      id: bookingId, receivedAt, name, email, guests, date, time, status: "New", privacyCodeHash: hashPrivacyCode(privacyCode),
    });
    response.status(201).json({ bookingId, privacyCode, workbookUpdated, message: "Booking request recorded." });
  } catch (error) {
    if (!isValidationError(error)) reportServerError(request, error);
    sendApiError(request, response, isValidationError(error) ? 400 : 500, isValidationError(error) ? error.message : "Could not save booking request. Try again shortly.");
  }
});

app.post("/api/orders", publicWriteLimiter, async (request, response) => {
  try {
    const customer = cleanText(request.body.customer, "name");
    const phone = cleanText(request.body.phone, "phone number", 30);
    const fulfillment = request.body.fulfillment === "Delivery" ? "Delivery" : "Pickup";
    const notes = cleanOptionalText(request.body.notes, "notes");
    const requestedItems = Array.isArray(request.body.items) ? request.body.items : [];
    const items = requestedItems.map((item) => {
      const catalogItem = menu.get(item.id);
      const quantity = Number(item.quantity);
      if (!catalogItem || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
        throw new Error("Your order contains an invalid item.");
      }
      return { ...catalogItem, quantity };
    });
    if (!items.length) throw new Error("Add at least one item before ordering.");

    const orderId = `OR-${Date.now()}`;
    const receivedAt = new Date().toISOString();
    const privacyCode = createPrivacyCode();
    const itemSummary = items.map((item) => `${item.quantity}x ${item.name}`).join(", ");
    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const workbookUpdated = await saveRecord("orders", {
      id: orderId, receivedAt, customer, phone, fulfillment, items: itemSummary, total, notes, status: "New", privacyCodeHash: hashPrivacyCode(privacyCode),
    });
    response.status(201).json({ orderId, privacyCode, workbookUpdated, message: "Order recorded.", total });
  } catch (error) {
    if (!isValidationError(error)) reportServerError(request, error);
    sendApiError(request, response, isValidationError(error) ? 400 : 500, isValidationError(error) ? error.message : "Could not save order. Try again shortly.");
  }
});

app.post("/api/privacy/delete", privacyDeleteLimiter, async (request, response) => {
  const requestId = String(request.body.requestId ?? "").trim();
  const privacyCode = String(request.body.privacyCode ?? "").trim();
  if (!/^((BK)|(OR))-\d{10,}$/.test(requestId) || !/^[a-f0-9]{24}$/i.test(privacyCode)) {
    sendApiError(request, response, 400, "Enter a valid request ID and privacy code.");
    return;
  }

  const nextWrite = writeQueue.then(async () => {
    const records = await readRecords();
    const matchingType = requestId.startsWith("BK-") ? "bookings" : "orders";
    const index = records[matchingType].findIndex((record) => {
      if (!record.privacyCodeHash) return false;
      return timingSafeEqual(Buffer.from(record.privacyCodeHash), Buffer.from(hashPrivacyCode(privacyCode))) && record.id === requestId;
    });
    if (index < 0) return false;
    records[matchingType].splice(index, 1);
    await fs.writeFile(recordsPath, JSON.stringify(records, null, 2), "utf8");
    await refreshWorkbookCopy();
    return true;
  });
  writeQueue = nextWrite.catch(() => {});

  try {
    const deleted = await nextWrite;
    response.status(deleted ? 200 : 404).json({ message: deleted ? "Your saved request has been deleted." : "No matching saved request was found.", requestId: request.correlationId });
  } catch (error) {
    reportServerError(request, error);
    sendApiError(request, response, 500, "Could not delete the saved request. Try again shortly.");
  }
});

app.get("/api/export", adminLimiter, requireAdmin, async (_request, response) => {
  try {
    const workbook = await createWorkbook();
    const downloadPath = path.join(dataDirectory, `mori-orders-bookings-${Date.now()}.xlsx`);
    await workbook.xlsx.writeFile(downloadPath);
    response.download(downloadPath, "mori-orders-bookings.xlsx", () => {
      fs.unlink(downloadPath).catch(() => {});
    });
  } catch (error) {
    reportServerError(_request, error);
    sendApiError(_request, response, 500, "Could not prepare the workbook export. Try again shortly.");
  }
});

app.use("/api", (request, response) => sendApiError(request, response, 404, "Not found."));
app.use(express.static(path.join(__dirname, "dist")));
app.use((_request, response) => response.sendFile(path.join(__dirname, "dist", "index.html")));
app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  reportServerError(request, error);
  return sendApiError(request, response, 500, "An unexpected server error occurred.");
});

app.listen(port, "0.0.0.0", () => {
  console.info(`Mori Cafe server started on port ${port}.`);
  refreshWorkbookCopy().catch((error) => reportServerError({ correlationId: "startup" }, error));
});

setInterval(() => {
  if (!workbookPending) return;
  const retry = writeQueue.then(() => refreshWorkbookCopy());
  writeQueue = retry.catch(() => {});
}, 5000);
