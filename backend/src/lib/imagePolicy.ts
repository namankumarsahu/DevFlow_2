// Checks on a built image, from `docker image inspect <tag> --format '{{json .}}'`, before it is allowed to run.
export type ImagePolicy = { maxImageMb: number; rejectVolumes: boolean };

export function checkImage(inspectJson: string, policy: ImagePolicy): string | null {
  let img: { Size?: number; Config?: { Volumes?: Record<string, unknown> | null } };
  try {
    img = JSON.parse(inspectJson);
  } catch {
    return 'Could not read the built image metadata';
  }
  const mb = (img.Size ?? 0) / (1024 * 1024);
  if (mb > policy.maxImageMb) return `Built image is ${Math.round(mb)} MB, above the ${policy.maxImageMb} MB limit`;
  // An image-declared VOLUME silently creates an anonymous docker volume outside the container's size-limited
  // writable layer, so it would bypass every disk limit.
  const volumes = Object.keys(img.Config?.Volumes ?? {});
  if (policy.rejectVolumes && volumes.length) return `The image declares VOLUME ${volumes.join(', ')}. Volumes are not allowed (they bypass disk limits); remove the VOLUME instruction`;
  return null;
}
