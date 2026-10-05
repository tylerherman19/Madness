export default function PoolRules({ rules }: { rules: readonly string[] }) {
  return <ol className="card pool-rules" role="list">
    {rules.map((text, index) => <li className="pool-rule" key={index}>
      <span className="pool-rule-number" aria-hidden="true">{index + 1}</span>
      <span>{text}</span>
    </li>)}
  </ol>
}
