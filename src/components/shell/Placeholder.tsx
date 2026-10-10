export function Placeholder({ name }: { name: string }) {
  return (
    <div className="placeholder" tabIndex={0} data-autofocus>
      <div>{name}</div>
      <div className="sub">Not implemented yet</div>
    </div>
  );
}
