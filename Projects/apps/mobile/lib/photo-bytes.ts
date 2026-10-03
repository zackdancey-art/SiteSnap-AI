import { File, Paths } from "expo-file-system";

import type { Photo } from "@/lib/types";

/**
 * Turning a queued photograph back into a file the uploader can send.
 *
 * WHY THIS IS NEEDED AT ALL
 *
 * `uploadPhotoOnce` sends a photograph by handing FormData a `uri` and letting
 * the native layer read that path off disk. That works for a photograph taken
 * seconds ago, because `createStoredPhoto` hands back an ImageManipulator path
 * in the **cache** directory. It does not work for a photograph captured with
 * no coverage: by the time there is coverage the app may have been killed, the
 * phone rebooted, and the cache purged — iOS makes no promise about that
 * directory surviving anything.
 *
 * What does survive is the base64 written to AsyncStorage at capture time
 * (`savePhotoPayloads`). So the queued path reverses the capture: read the
 * durable bytes back, write them to a fresh cache file, upload that file, and
 * delete it. The photograph is unchanged by the round trip — base64 is a
 * lossless encoding of the same bytes `manipulateAsync` produced, and nothing
 * here re-encodes, recompresses or re-orients anything.
 *
 * If the original cache file is still there, nothing is written: the common
 * case (coverage returns while the app is still running) costs one `exists`
 * check.
 */
export interface MaterializedPhoto {
  /** A `file://` uri that exists on disk right now. */
  uri: string;
  /** Deletes the temporary copy, if this call created one. Never throws. */
  release: () => void;
}

function fileExists(uri: string | undefined | null): boolean {
  if (!uri || !uri.startsWith("file://")) return false;
  try {
    return new File(uri).exists;
  } catch {
    // An unreadable path is indistinguishable from an absent one for our
    // purposes, and both are answered by writing a fresh copy.
    return false;
  }
}

export function materializeQueuedPhoto(photo: Photo): MaterializedPhoto {
  if (fileExists(photo.uri)) {
    return { uri: photo.uri, release: () => {} };
  }

  if (!photo.base64) {
    // Deliberately loud. This is the one state in which a queued photograph
    // cannot be recovered: the cache file is gone and the durable copy was
    // never written. It must surface as a failed sync the user can see, not as
    // an entry quietly posted with one photograph fewer.
    throw new Error(
      `Photograph ${photo.id} has no local bytes: its cache file is gone and no payload was stored.`
    );
  }

  const extension = photo.mimeType === "image/png" ? "png" : "jpg";
  const file = new File(Paths.cache, `sitesnap-queued-${photo.id}.${extension}`);
  if (file.exists) file.delete();
  file.create();
  file.write(photo.base64, { encoding: "base64" });

  return {
    uri: file.uri,
    release: () => {
      try {
        if (file.exists) file.delete();
      } catch {
        // A leftover file in the cache directory is the OS's problem to
        // reclaim; failing to delete it must not fail a successful upload.
      }
    },
  };
}
