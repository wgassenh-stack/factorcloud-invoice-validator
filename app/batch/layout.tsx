export default function BatchLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <>
    <div className="portalRouteNavWrap">
      <nav className="portalNav"><a className="portalBrand" href="/"><span>FC</span><strong>Client Portal</strong></a><div className="portalNavLinks"><a href="/">Dashboard</a><a href="/submit">Submit invoice</a><a className="active" href="/batch">Batch upload</a><a href="/risk">Alerts</a></div><div className="portalAccount"><span>Sandbox</span></div></nav>
    </div>
    {children}
  </>;
}
