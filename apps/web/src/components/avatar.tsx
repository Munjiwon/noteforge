type User = {
  name: string;
  color: string;
  avatarUrl?: string | null;
};

const SIZES = {
  xs: { box: "w-5 h-5", text: "text-[9px]" },
  sm: { box: "w-6 h-6", text: "text-[10px]" },
  md: { box: "w-7 h-7", text: "text-xs" },
  lg: { box: "w-10 h-10", text: "text-sm" },
  xl: { box: "w-16 h-16", text: "text-lg" },
};

export function Avatar({
  user,
  size = "sm",
  className = "",
}: {
  user: User;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const s = SIZES[size];
  const initial = (user.name || "?").trim().slice(0, 1).toUpperCase();
  if (user.avatarUrl) {
    return (
      <span
        className={`${s.box} inline-block rounded-full overflow-hidden bg-gray-100 ${className}`}
        title={user.name}
      >
        <img
          src={user.avatarUrl}
          alt={user.name}
          className="w-full h-full object-cover"
        />
      </span>
    );
  }
  return (
    <span
      className={`${s.box} ${s.text} inline-flex items-center justify-center rounded-full text-white font-medium shrink-0 ${className}`}
      style={{ background: user.color }}
      title={user.name}
    >
      {initial}
    </span>
  );
}
