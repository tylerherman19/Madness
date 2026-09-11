export default function LogoMark({ size = 44 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size, fontSize: size * 0.62 }} aria-hidden="true">
      M
    </span>
  )
}
