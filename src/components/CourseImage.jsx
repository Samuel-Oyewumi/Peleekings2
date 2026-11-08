import { useState } from "react";

export default function CourseImage({ src, alt = "", label, style }) {
  const [failedSrc, setFailedSrc] = useState(null);

  const trimmedSrc = typeof src === "string" ? src.trim() : "";
  const hasFailed = !trimmedSrc || failedSrc === trimmedSrc;

  if (hasFailed) {
    return (
      <div
        role="img"
        aria-label={alt || label || "Course cover"}
        className="course-img-fallback"
        style={style}
      >
        <span>{label || alt}</span>
      </div>
    );
  }

  return (
    <img
      src={trimmedSrc}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      style={style}
      onError={() => setFailedSrc(trimmedSrc)}
    />
  );
}
