import { Router } from "express";
import multer from "multer";
import { requireAuth, AuthenticatedRequest, AUTH_ERROR_CODES } from "../middleware/auth";
import { verifyAuthToken } from "../utils/authToken";
import { getMediaStorage } from "../storage/mediaStorage";
import { signUploadPath, verifyUploadSignature } from "../utils/signedUrl";
import { recordUpload, uploadBelongsToActorCompany } from "../storage/uploadsStore";
import { rateLimit } from "../middleware/rateLimit";

export const uploadsRouter: Router = Router();

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type "${file.mimetype}" is not allowed. Only images may be uploaded.`));
    }
  },
});

const storage = getMediaStorage();

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

uploadsRouter.post("/uploads", requireAuth, rateLimit("uploads-post", 30, 60 * 60 * 1000), upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Missing file field 'file' in multipart form-data." });
  }

  try {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filename = sanitizeFilename(req.file.originalname || `${id}.jpg`);
    const saved = await storage.saveFile({
      id,
      filename,
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
    });

    // H7: bind the upload to the authenticated uploader's company at upload time
    // (unforgeable). Fetch/sign authorize against this record, not entry JSON.
    await recordUpload((req as AuthenticatedRequest).auth, id, filename);

    // Return canonical path only — callers use POST /uploads/sign to get a time-limited URL
    const canonicalPath = `/api/uploads/${id}/${filename}`;
    return res.json({
      id,
      filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
      url: canonicalPath,
      storageKey: saved.storageKey,
      storagePath: saved.storagePath,
    });
  } catch (error) {
    console.error("[uploads] save failed", error);
    return res.status(500).json({ error: "Failed to store upload." });
  }
});

// Batch sign endpoint — accepts an array of canonical paths, returns short-lived HMAC URLs.
// H7: a URL is only minted for a file that belongs to the caller's company, so a
// signed URL can never be obtained for another tenant's media (this also makes a
// valid signature sufficient authorization on the fetch path below).
uploadsRouter.post("/uploads/sign", requireAuth, async (req, res) => {
  const paths = req.body?.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: "paths must be a non-empty array of strings." });
  }
  if (paths.length > 50) {
    return res.status(400).json({ error: "Maximum 50 paths per sign request." });
  }

  const companyId = (req as AuthenticatedRequest).auth.companyId;
  const base = `${req.protocol}://${req.get("host")}`;
  const signed = await Promise.all(
    (paths as unknown[]).map(async (raw) => {
      const path = typeof raw === "string" ? raw.trim() : "";
      // Extract id and filename from /api/uploads/:id/:filename
      const match = path.match(/\/api\/uploads\/([^/]+)\/([^/?]+)/);
      if (!match) return { path, url: null, error: "Invalid upload path." };
      const [, id, filename] = match;
      if (!(await uploadBelongsToActorCompany({ companyId }, id))) {
        // Do not confirm existence of another tenant's file.
        return { path, url: null, error: "Not found." };
      }
      const { sig, exp } = signUploadPath(id, filename);
      return {
        path,
        url: `${base}/api/uploads/${id}/${filename}?sig=${encodeURIComponent(sig)}&exp=${exp}`,
      };
    })
  );

  return res.json({ signed });
});

uploadsRouter.get("/uploads/:id/:filename", async (req, res) => {
  const id = String(req.params.id || "").trim();
  const filename = sanitizeFilename(String(req.params.filename || "").trim());
  if (!id || !filename) {
    return res.status(400).json({ error: "Invalid upload path." });
  }

  // Accept: Authorization: Bearer <jwt>  OR  ?sig=<hmac>&exp=<ts>
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  if (bearerToken) {
    // H7: a valid token is NOT sufficient — the file must belong to the caller's
    // company. Otherwise any authenticated user could fetch any tenant's media.
    const claims = verifyAuthToken(bearerToken);
    if (!claims) {
      return res.status(401).json({
        error: "Authentication required for media access.",
        code: AUTH_ERROR_CODES.SESSION_EXPIRED,
      });
    }
    if (!(await uploadBelongsToActorCompany({ companyId: claims.companyId }, id))) {
      // 404, not 403 — don't confirm the file exists to another tenant.
      return res.status(404).json({ error: "Upload not found." });
    }
  } else {
    // Signed URLs are minted only by POST /uploads/sign, which is company-gated,
    // so a valid signature already implies the issuer's company owned the file.
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    const exp = typeof req.query.exp === "string" ? req.query.exp : "";
    if (!(sig !== "" && exp !== "" && verifyUploadSignature(id, filename, sig, exp))) {
      // A missing or stale signature is not a dead session: the caller never
      // presented a token on this request, and the fix is to re-sign the URL.
      return res.status(401).json({
        error: "Authentication required for media access.",
        code: AUTH_ERROR_CODES.NO_CREDENTIAL,
      });
    }
  }

  try {
    const storageKey = `uploads/${id}-${filename}`;
    const buffer = await storage.readFile(storageKey, filename);
    const extension = filename.split(".").pop()?.toLowerCase();
    const contentType =
      extension === "png"
        ? "image/png"
        : extension === "webp"
          ? "image/webp"
          : extension === "gif"
            ? "image/gif"
            : "image/jpeg";
    res.setHeader("Content-Type", contentType);
    // Signed URLs are short-lived, so a slightly longer client cache is fine
    res.setHeader("Cache-Control", "private, max-age=3600");
    /**
     * Cross-Origin-Resource-Policy, relaxed from Helmet's global `same-origin`
     * to `same-site` — FOR THIS ROUTE ONLY.
     *
     * Helmet's default sets `Cross-Origin-Resource-Policy: same-origin` on
     * every response (`server.ts`, the `app.use(helmet(...))` block). For a
     * JSON API that is exactly right. For the one route that serves images
     * meant to be embedded by a document on another origin, it is fatal: the
     * supervisor portal is served from `app.getsitesnapai.com` and this API
     * from `api.getsitesnapai.com`, so every `<img>` in the portal is a
     * cross-origin subresource, and `same-origin` tells the browser to fetch
     * the bytes, read this header, and then throw the response away without
     * handing it to the page. Chromium reports it as
     * `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`; Safari shows a Network row
     * with no status and no headers at all, which is why it read as a network
     * failure rather than a policy refusal.
     *
     * This has been blocking every photograph in the portal since Helmet was
     * added, sitting one layer behind the CSP `img-src` defect (AUDIT L48).
     * Fixing the CSP did not reveal a new bug; it revealed the next one in a
     * stack of two. See the state table in L43.
     *
     * `same-site`, not `cross-origin`. `app.` and `api.` share the registrable
     * domain `getsitesnapai.com`, so `same-site` permits exactly the embed the
     * product needs and nothing more — an unrelated origin still cannot embed
     * a photograph even if it somehow obtained a signed URL. `cross-origin`
     * would hand that away for no benefit.
     *
     * Scoped here rather than in the global Helmet configuration deliberately:
     * every other endpoint keeps `same-origin`.
     *
     * CORP does not apply to top-level navigation, which is why pasting a
     * signed URL straight into a browser tab has always displayed the
     * photograph correctly, and why the defect could not be reproduced that
     * way. It also does not apply to React Native's image loader, which is not
     * a browser document context — the mobile app was never affected.
     */
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    return res.send(buffer);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && String((error as { code?: string }).code) === "ENOENT") {
      return res.status(404).json({ error: "Upload not found." });
    }
    console.error("[uploads] read failed", error);
    return res.status(404).json({ error: "Upload not found." });
  }
});
