// Solutions Architect track (Azure): modules, lessons with diagrams, quiz questions,
// scenario case studies (kind "scenario") and sizing/cost calculations (kind "calc").

window.TRAINER = window.TRAINER || {};

TRAINER.domains.push(
  { id: "sa-platform", track: "architect", title: "Azure Databricks Platform Architecture", short: "Platform",
    summary: "Control and compute planes, workspace deployment, VNet injection, secure cluster connectivity, Private Link and serverless networking." },
  { id: "sa-security", track: "architect", title: "Identity, Security & Governance Design", short: "Security",
    summary: "Entra ID and account-level identity, service principals, secrets, encryption keys and Unity Catalog topology." },
  { id: "sa-reference", track: "architect", title: "Lakehouse Reference Architectures", short: "Reference",
    summary: "Batch and streaming ingestion on Azure, medallion pipelines, BI serving with Power BI, and ML/GenAI architectures." },
  { id: "sa-cost", track: "architect", title: "Sizing, Performance & Cost", short: "Cost",
    summary: "The DBU pricing model, choosing and sizing compute, SQL warehouse scaling, compute policies and cost monitoring." },
  { id: "sa-ops", track: "architect", title: "Migration, DR & Operations", short: "Operations",
    summary: "Migrating warehouses and Hive metastores, disaster recovery, infrastructure as code and CI/CD across environments." }
);

// Shared SVG arrowhead definition; each diagram gets its own id so several can share a page.
const saArrow = (id, cls = "") => `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-head ${cls}"/></marker></defs>`;

TRAINER.lessons.push(
  // ---------------------------------------------------------------- platform
  {
    id: "sa-arch-planes", domain: "sa-platform", title: "Control Plane, Compute Planes and Workspaces", minutes: 10,
    body: `
<p>Every Azure Databricks design decision starts from one split: what Databricks runs for you, and what runs in your Azure subscription.</p>

<figure class="diagram">
<svg viewBox="0 0 760 400" role="img" aria-label="Users reach the control plane over front-end Private Link. Classic cluster VMs in the customer VNet open outbound-only connections to the secure cluster connectivity relay and reach ADLS through a private endpoint. Serverless compute runs in a Databricks-managed plane and reaches ADLS through a network connectivity configuration.">
  ${saArrow("a1")}${saArrow("a1x", "d-accent-fill")}
  <rect class="d-box" x="20" y="55" width="120" height="40" rx="6"/>
  <text x="80" y="80" text-anchor="middle" class="d-label">Users / BI tools</text>

  <rect class="d-group" x="240" y="20" width="300" height="120" rx="8"/>
  <text x="390" y="42" text-anchor="middle" class="d-title">Control plane (Databricks-managed)</text>
  <rect class="d-box" x="255" y="55" width="130" height="40" rx="6"/>
  <text x="320" y="80" text-anchor="middle" class="d-label">Web app &amp; REST API</text>
  <rect class="d-box" x="395" y="55" width="130" height="40" rx="6"/>
  <text x="460" y="80" text-anchor="middle" class="d-label">SCC relay</text>

  <rect class="d-group" x="570" y="20" width="170" height="120" rx="8"/>
  <text x="655" y="42" text-anchor="middle" class="d-title">Serverless compute plane</text>
  <text x="655" y="75" text-anchor="middle" class="d-note">Databricks-managed</text>
  <text x="655" y="93" text-anchor="middle" class="d-note">SQL warehouses, jobs,</text>
  <text x="655" y="109" text-anchor="middle" class="d-note">notebooks, pipelines</text>

  <rect class="d-group" x="225" y="200" width="520" height="185" rx="8"/>
  <text x="485" y="222" text-anchor="middle" class="d-title">Your Azure subscription</text>
  <rect class="d-group" x="240" y="235" width="280" height="135" rx="8"/>
  <text x="380" y="257" text-anchor="middle" class="d-note">workspace VNet (VNet injection)</text>
  <rect class="d-box" x="255" y="275" width="120" height="40" rx="6"/>
  <text x="315" y="300" text-anchor="middle" class="d-label">host subnet</text>
  <rect class="d-box" x="385" y="275" width="120" height="40" rx="6"/>
  <text x="445" y="300" text-anchor="middle" class="d-label">container subnet</text>
  <text x="380" y="345" text-anchor="middle" class="d-note">each cluster VM uses one IP in each subnet</text>
  <rect class="d-box" x="600" y="265" width="130" height="70" rx="6"/>
  <text x="665" y="295" text-anchor="middle" class="d-label">ADLS Gen2</text>
  <text x="665" y="313" text-anchor="middle" class="d-note">Unity Catalog data</text>

  <line x1="140" y1="75" x2="253" y2="75" class="d-line" marker-end="url(#a1)"/>
  <text x="197" y="66" text-anchor="middle" class="d-note">front-end</text>
  <text x="197" y="91" text-anchor="middle" class="d-note">Private Link</text>

  <line x1="445" y1="273" x2="445" y2="97" class="d-line d-accent" marker-end="url(#a1x)"/>
  <text x="437" y="166" text-anchor="end" class="d-note d-accent-text">outbound only</text>
  <text x="437" y="181" text-anchor="end" class="d-note">(SCC, back-end Private Link)</text>

  <line x1="520" y1="300" x2="598" y2="300" class="d-line" marker-end="url(#a1)"/>
  <text x="559" y="290" text-anchor="middle" class="d-note">private</text>
  <text x="559" y="322" text-anchor="middle" class="d-note">endpoint</text>

  <line x1="665" y1="140" x2="665" y2="263" class="d-line" marker-end="url(#a1)"/>
  <text x="657" y="172" text-anchor="end" class="d-note">serverless NCC</text>
  <text x="657" y="187" text-anchor="end" class="d-note">private endpoint</text>
</svg>
<figcaption>Clusters never accept inbound connections: they call out to the relay. Data stays in your storage account, reached privately by both classic and serverless compute.</figcaption>
</figure>

<h3>The planes</h3>
<ul>
  <li><strong>Control plane</strong>: run by Databricks in its own Azure subscription. It holds the web app, REST APIs, job scheduler, cluster manager, notebook source and Unity Catalog metadata services.</li>
  <li><strong>Classic compute plane</strong>: cluster VMs in <em>your</em> subscription, in a managed resource group, attached to a VNet (Databricks-managed or one you supply with <strong>VNet injection</strong>).</li>
  <li><strong>Serverless compute plane</strong>: compute run by Databricks in the same region, for serverless SQL warehouses, jobs, notebooks and pipelines. Starts in seconds and needs no VNet or quota planning, but you control its network access differently (see the next lesson).</li>
</ul>

<h3>Workspaces and the account</h3>
<ul>
  <li>An <strong>account</strong> (managed in the account console) contains workspaces, identities, Unity Catalog metastores and account-level settings.</li>
  <li>A <strong>workspace</strong> is deployed into a region and an Azure resource group. It has its own URL, compute, jobs and notebooks.</li>
  <li>Common split: one workspace per <strong>environment</strong> (dev / test / prod), sometimes also per business unit, all attached to the same regional metastore so data governance stays in one place.</li>
  <li>Premium tier is needed for Unity Catalog, Private Link, customer-managed keys and most enterprise security features. Design on Premium.</li>
</ul>

<div class="callout"><strong>Architect's rule of thumb:</strong> workspaces isolate <em>compute and code</em>, and Unity Catalog isolates <em>data</em>. Don't create a workspace just to hide a table. Use catalog permissions and workspace bindings instead.</div>

<h3>Questions to ask before you deploy</h3>
<ol>
  <li>Which regions are needed (data residency, latency to sources and users, DR pair)?</li>
  <li>Must all traffic be private (no public internet path to the workspace or storage)?</li>
  <li>Will most workloads run serverless, or does classic compute need custom VNets, peering or on-prem connectivity?</li>
  <li>How many concurrent cluster nodes at peak? That decides subnet sizes, and they're hard to change later.</li>
  <li>Who owns identity (Entra ID groups) and who will be the metastore and workspace admins?</li>
</ol>
`
  },
  {
    id: "sa-network", domain: "sa-platform", title: "Networking: VNet Injection, SCC and Private Link", minutes: 11,
    body: `
<h3>VNet injection</h3>
<p>Deploy the workspace into a VNet you own, so you control routing, NSG rules, peering, firewalls and on-premises connectivity.</p>
<ul>
  <li>The workspace needs <strong>two dedicated subnets</strong>, a <em>host</em> (public) subnet and a <em>container</em> (private) subnet, both delegated to <code>Microsoft.Databricks/workspaces</code>, each with a network security group.</li>
  <li>Every cluster node takes <strong>one IP in each subnet</strong>. Azure reserves 5 addresses per subnet, so a <code>/26</code> (64 addresses) supports 59 nodes. Size for peak concurrency across <em>all</em> clusters in the workspace, with headroom.</li>
  <li>Subnets can't be shared with other resources or other workspaces.</li>
  <li>Use a user-defined route plus Azure Firewall or an NVA to inspect or restrict egress. Allow the required Databricks service tags and endpoints.</li>
</ul>

<h3>Secure cluster connectivity (No Public IP)</h3>
<ul>
  <li>Cluster VMs get <strong>no public IP addresses</strong>, and NSGs need <strong>no inbound rules</strong>.</li>
  <li>Each cluster opens an <strong>outbound</strong> TLS connection to the SCC relay in the control plane. The control plane manages clusters over that tunnel.</li>
  <li>This is the default and recommended setting for new workspaces. Egress still needs a path: a NAT gateway (the default for SCC with VNet injection), Azure Firewall, or back-end Private Link.</li>
</ul>

<h3>Private Link</h3>
<table class="ref">
  <tr><th>Connection</th><th>From → to</th><th>Why</th></tr>
  <tr><td><strong>Front-end</strong> (user to workspace)</td><td>Users, BI tools, CI/CD → web app and REST API</td><td>Reach the workspace only from your network. Combine with disabling public network access.</td></tr>
  <tr><td><strong>Back-end</strong> (compute to control plane)</td><td>Cluster VMs → SCC relay and REST API</td><td>Cluster-to-control-plane traffic stays on the Microsoft backbone, through private endpoints in your VNet.</td></tr>
  <tr><td><strong>Browser authentication</strong></td><td>Entra ID login callback → workspace</td><td>Needed for web SSO with front-end Private Link. One private endpoint per region, usually on a small dedicated "web auth" workspace.</td></tr>
</table>
<p>For storage, use <strong>private endpoints on ADLS Gen2</strong> (the <code>dfs</code> and <code>blob</code> sub-resources) and disable public access on the storage account.</p>

<h3>Serverless networking</h3>
<ul>
  <li>Serverless compute doesn't run in your VNet, so VNet rules don't apply to it.</li>
  <li>A <strong>network connectivity configuration (NCC)</strong>, created at the account level and attached to workspaces, provides either stable subnet IDs to allow on your storage firewall or <strong>private endpoints</strong> from the serverless plane to your ADLS or other Azure resources.</li>
  <li><strong>Serverless egress control</strong> (network policies) restricts which internet destinations serverless workloads can reach.</li>
</ul>

<h3>Typical designs</h3>
<table class="ref">
  <tr><th>Requirement</th><th>Design</th></tr>
  <tr><td>Standard enterprise</td><td>VNet injection + SCC + NAT gateway, private endpoints to ADLS, IP access lists on the workspace</td></tr>
  <tr><td>Fully private (banking, healthcare)</td><td>Hub-and-spoke: front-end and back-end Private Link, browser-auth endpoint, public access disabled, Azure Firewall egress, NCC private endpoints for serverless</td></tr>
  <tr><td>Fast start, analytics-first</td><td>Serverless compute with an NCC to storage. Little VNet design needed.</td></tr>
</table>
`
  },

  // ---------------------------------------------------------------- security
  {
    id: "sa-identity", domain: "sa-security", title: "Identity, Secrets and Encryption", minutes: 10,
    body: `
<h3>Identity comes from Entra ID, at the account level</h3>
<ul>
  <li>Sync users, groups and service principals from Microsoft Entra ID to the <strong>Databricks account</strong>, using <strong>automatic identity management</strong> or the account-level SCIM provisioning connector. Then assign account groups to workspaces.</li>
  <li>Grant permissions (workspace access, Unity Catalog privileges, cluster policies) to <strong>groups</strong>, not individuals. Workspace-local groups are a legacy pattern that can't be used in Unity Catalog grants.</li>
  <li>Admin roles: <em>account admin</em> (account, metastores, workspaces), <em>metastore admin</em> (optional; owns top-level UC objects), <em>workspace admin</em>. Keep each set small and use groups for them too.</li>
</ul>

<h3>Automation identities</h3>
<ul>
  <li>Run production jobs, CI/CD and integrations as <strong>service principals</strong> (Entra ID-managed or Databricks-managed), using OAuth machine-to-machine tokens or Entra ID tokens.</li>
  <li>Avoid personal access tokens for production. If you have to allow them, set maximum lifetimes and restrict who can create them.</li>
  <li>Set jobs to <em>run as</em> a service principal, so production doesn't depend on someone's personal account.</li>
</ul>

<h3>Secrets</h3>
<ul>
  <li>Use an <strong>Azure Key Vault-backed secret scope</strong> (or a Databricks-backed scope) and read values with <code>dbutils.secrets.get(scope, key)</code>. Secret values are redacted in notebook output.</li>
  <li>For storage, prefer Unity Catalog storage credentials backed by a <strong>managed identity</strong> (the Access Connector for Azure Databricks). Then there's no secret at all to rotate.</li>
</ul>

<h3>Encryption</h3>
<table class="ref">
  <tr><th>Customer-managed key for</th><th>Protects</th></tr>
  <tr><td>Managed services</td><td>Data at rest in the control plane: notebook source, secrets, query history</td></tr>
  <tr><td>Managed disks</td><td>OS and data disks of classic cluster VMs</td></tr>
  <tr><td>Workspace storage (DBFS root)</td><td>The workspace's own storage account</td></tr>
</table>
<p>Your own ADLS accounts use Azure Storage encryption, optionally with your keys in Key Vault. Data in transit is TLS, and node-to-node encryption can be turned on for clusters.</p>

<h3>Auditing</h3>
<p>Query <code>system.access.audit</code> for workspace and account events, and stream diagnostic logs to Log Analytics or Event Hubs for your SIEM. Unity Catalog lineage system tables show who read and wrote what.</p>
`
  },
  {
    id: "sa-uc-design", domain: "sa-security", title: "Designing the Unity Catalog Topology", minutes: 10,
    body: `
<figure class="diagram">
<svg viewBox="0 0 760 310" role="img" aria-label="One account holds one metastore per region. The West Europe metastore contains the catalogs sales_dev, sales_prod and hr_prod. sales_dev is bound only to the dev workspace, and sales_prod and hr_prod only to the prod workspace.">
  ${saArrow("a2")}
  <rect class="d-box" x="230" y="15" width="300" height="40" rx="6"/>
  <text x="380" y="40" text-anchor="middle" class="d-label">Databricks account · Entra ID groups</text>
  <rect class="d-box" x="230" y="85" width="300" height="40" rx="6"/>
  <text x="380" y="110" text-anchor="middle" class="d-label">Metastore · West Europe</text>
  <line x1="380" y1="55" x2="380" y2="83" class="d-line" marker-end="url(#a2)"/>
  <text x="390" y="74" class="d-note">one per region</text>

  <polyline points="380,125 380,145" class="d-line"/>
  <polyline points="135,145 625,145" class="d-line"/>
  <line x1="135" y1="145" x2="135" y2="163" class="d-line" marker-end="url(#a2)"/>
  <line x1="380" y1="145" x2="380" y2="163" class="d-line" marker-end="url(#a2)"/>
  <line x1="625" y1="145" x2="625" y2="163" class="d-line" marker-end="url(#a2)"/>
  <text x="388" y="139" class="d-note">contains</text>

  <rect class="d-box" x="60" y="165" width="150" height="40" rx="6"/>
  <text x="135" y="190" text-anchor="middle" class="d-label">sales_dev</text>
  <rect class="d-box" x="305" y="165" width="150" height="40" rx="6"/>
  <text x="380" y="190" text-anchor="middle" class="d-label">sales_prod</text>
  <rect class="d-box" x="550" y="165" width="150" height="40" rx="6"/>
  <text x="625" y="190" text-anchor="middle" class="d-label">hr_prod</text>

  <line x1="135" y1="205" x2="135" y2="253" class="d-line d-accent d-dash"/>
  <text x="143" y="235" class="d-note d-accent-text">binding</text>
  <polyline points="380,205 380,230 470,230 470,253" class="d-line d-accent d-dash"/>
  <polyline points="625,205 625,230 540,230 540,253" class="d-line d-accent d-dash"/>
  <text x="505" y="222" text-anchor="middle" class="d-note d-accent-text">bindings</text>

  <rect class="d-box" x="60" y="255" width="150" height="40" rx="6"/>
  <text x="135" y="280" text-anchor="middle" class="d-label">dev workspace</text>
  <rect class="d-box" x="428" y="255" width="150" height="40" rx="6"/>
  <text x="503" y="280" text-anchor="middle" class="d-label">prod workspace</text>
</svg>
<figcaption>One metastore per region is shared by every workspace there. Workspace-catalog bindings stop the dev workspace from even seeing production catalogs, whatever a user's grants are.</figcaption>
</figure>

<h3>Metastore</h3>
<ul>
  <li>Create <strong>one metastore per region</strong> in the account and attach every workspace in that region to it.</li>
  <li>Optionally give the metastore a managed storage location. Many designs instead set managed storage per catalog, so each business unit's data lands in its own ADLS account or container.</li>
</ul>

<h3>Catalog layout options</h3>
<table class="ref">
  <tr><th>Pattern</th><th>Example</th><th>Fits</th></tr>
  <tr><td>Catalog per environment</td><td><code>dev</code>, <code>prod</code> with schemas per domain</td><td>Small teams, simple promotion</td></tr>
  <tr><td>Catalog per domain × environment</td><td><code>sales_dev</code>, <code>sales_prod</code>, <code>hr_prod</code></td><td>Several business units with their own owners and storage (data-mesh style)</td></tr>
  <tr><td>Catalog per medallion layer</td><td><code>bronze</code>, <code>silver</code>, <code>gold</code></td><td>Central platform team. Grants by layer are easy, but domain ownership is blurrier.</td></tr>
</table>
<p>Whichever you pick, put the environment in the catalog name, not the table name, so the same code runs everywhere with a catalog parameter.</p>

<h3>Isolation and access</h3>
<ul>
  <li><strong>Workspace-catalog binding</strong>: a catalog is only visible from the workspaces it's bound to (for example, production catalogs only from production workspaces).</li>
  <li><strong>Grants</strong> to account groups: <code>USE CATALOG</code> / <code>USE SCHEMA</code> plus <code>SELECT</code> and <code>MODIFY</code>. Make groups the owners of catalogs and schemas, so ownership doesn't leave with a person.</li>
  <li><strong>Row filters, column masks and governed tags</strong> (with ABAC policies) handle PII without copying data into "safe" tables.</li>
  <li><strong>Storage</strong>: an Access Connector (managed identity) has <em>Storage Blob Data Contributor</em> on ADLS. Register it as a <strong>storage credential</strong>, then create <strong>external locations</strong> for the paths. Users never get direct storage permissions.</li>
</ul>

<h3>Sharing</h3>
<ul>
  <li>Inside the account, across regions: <strong>Databricks-to-Databricks Delta Sharing</strong> between metastores. No copies, though cross-region reads incur egress.</li>
  <li>With partners on other platforms: <strong>open Delta Sharing</strong>. With partners on Databricks: D2D sharing, or Clean Rooms for privacy-safe joins.</li>
</ul>
`
  },

  // ---------------------------------------------------------------- reference
  {
    id: "sa-ingest-patterns", domain: "sa-reference", title: "Ingestion and Streaming Reference Architecture", minutes: 11,
    body: `
<figure class="diagram">
<svg viewBox="0 0 760 190" role="img" aria-label="Events flow from Event Hubs over the Kafka endpoint into a bronze streaming table, then a silver streaming table with expectations, then a gold materialized view, all in one Lakeflow Declarative Pipeline, and are served through a SQL warehouse to Power BI.">
  ${saArrow("a3")}
  <rect class="d-group d-accent" x="131" y="30" width="371" height="110" rx="8"/>
  <text x="315" y="160" text-anchor="middle" class="d-note d-accent-text">one Lakeflow Declarative Pipeline</text>
  <rect class="d-box" x="10" y="60" width="100" height="56" rx="6"/>
  <text x="60" y="84" text-anchor="middle" class="d-label">Event Hubs</text>
  <text x="60" y="101" text-anchor="middle" class="d-note">devices, apps</text>
  <rect class="d-box" x="138" y="60" width="100" height="56" rx="6"/>
  <text x="188" y="84" text-anchor="middle" class="d-label">Bronze</text>
  <text x="188" y="101" text-anchor="middle" class="d-note">raw events</text>
  <rect class="d-box" x="266" y="60" width="100" height="56" rx="6"/>
  <text x="316" y="84" text-anchor="middle" class="d-label">Silver</text>
  <text x="316" y="101" text-anchor="middle" class="d-note">clean, deduped</text>
  <rect class="d-box" x="394" y="60" width="100" height="56" rx="6"/>
  <text x="444" y="84" text-anchor="middle" class="d-label">Gold</text>
  <text x="444" y="101" text-anchor="middle" class="d-note">aggregates</text>
  <rect class="d-box" x="522" y="60" width="100" height="56" rx="6"/>
  <text x="572" y="84" text-anchor="middle" class="d-label">SQL warehouse</text>
  <text x="572" y="101" text-anchor="middle" class="d-note">serverless</text>
  <rect class="d-box" x="650" y="60" width="100" height="56" rx="6"/>
  <text x="700" y="84" text-anchor="middle" class="d-label">Power BI</text>
  <text x="700" y="101" text-anchor="middle" class="d-note">dashboards</text>
  <line x1="110" y1="88" x2="136" y2="88" class="d-line" marker-end="url(#a3)"/>
  <line x1="238" y1="88" x2="264" y2="88" class="d-line" marker-end="url(#a3)"/>
  <line x1="366" y1="88" x2="392" y2="88" class="d-line" marker-end="url(#a3)"/>
  <line x1="494" y1="88" x2="520" y2="88" class="d-line" marker-end="url(#a3)"/>
  <line x1="622" y1="88" x2="648" y2="88" class="d-line" marker-end="url(#a3)"/>
  <text x="124" y="50" text-anchor="end" class="d-note">Kafka</text>
  <text x="252" y="50" text-anchor="middle" class="d-note">stream</text>
  <text x="380" y="50" text-anchor="middle" class="d-note">refresh</text>
  <text x="636" y="50" text-anchor="middle" class="d-note">SQL</text>
</svg>
<figcaption>A single pipeline owns bronze to gold, so dependencies, retries and data-quality metrics live in one place. Consumers only ever query gold, through a SQL warehouse.</figcaption>
</figure>

<h3>Choosing an ingestion path on Azure</h3>
<table class="ref">
  <tr><th>Source</th><th>Recommended</th><th>Notes</th></tr>
  <tr><td>Files landing in ADLS</td><td>Auto Loader (<code>cloudFiles</code>), or <code>read_files</code> in a declarative pipeline</td><td>For high volumes, use <strong>file notification mode</strong> (Event Grid plus a storage queue) or managed file events on a Unity Catalog external location, instead of listing directories.</td></tr>
  <tr><td>Event streams</td><td>Structured Streaming from <strong>Event Hubs through its Kafka endpoint</strong></td><td>Size Event Hubs throughput or processing units for peak. Partitions cap reader parallelism.</td></tr>
  <tr><td>SaaS apps and databases (Salesforce, SQL Server, ...)</td><td><strong>Lakeflow Connect</strong> managed connectors</td><td>Incremental and CDC-based, governed by Unity Catalog</td></tr>
  <tr><td>Existing Azure Data Factory estate</td><td>Keep ADF for copy and orchestration where it already works, and trigger Databricks jobs from it</td><td>New Databricks-native pipelines are simpler in Lakeflow Jobs</td></tr>
  <tr><td>Query an operational DB in place</td><td><strong>Lakehouse Federation</strong></td><td>Good for exploration and migration validation. Not for heavy recurring transformations.</td></tr>
</table>

<h3>Batch vs. streaming is a latency and cost choice</h3>
<ul>
  <li>The same streaming code can run <strong>triggered</strong> (<code>availableNow</code>, every 15 minutes or hourly, cluster off in between) or <strong>continuously</strong> (seconds of latency, compute always on).</li>
  <li>Start from the business SLA. "Dashboards refresh every 30 minutes" doesn't need a 24×7 cluster.</li>
  <li>Use <strong>streaming tables</strong> for append and CDC flows (with <code>AUTO CDC</code> for SCD type 1 and 2) and <strong>materialized views</strong> for gold aggregates.</li>
</ul>

<h3>Medallion conventions worth standardizing</h3>
<ul>
  <li>Bronze keeps source fidelity plus ingestion metadata (<code>_metadata.file_path</code>, ingest time), so you can replay.</li>
  <li>Silver enforces types, keys and expectations. Quarantine rather than silently drop when the business needs to see bad records.</li>
  <li>Gold is modelled for consumers: star schemas for BI, feature tables for ML.</li>
</ul>
`
  },
  {
    id: "sa-serving", domain: "sa-reference", title: "Serving: BI, Data Warehousing and AI", minutes: 10,
    body: `
<h3>Databricks SQL as the warehouse</h3>
<ul>
  <li><strong>Serverless SQL warehouses</strong> start in seconds, scale out automatically for concurrency and stop when idle. They're the default for BI.</li>
  <li><strong>Warehouse size</strong> (2X-Small to 4X-Large) sets the power for each query. <strong>Min/max clusters</strong> set how many concurrent queries it can handle.</li>
  <li>Model gold as star schemas, with primary and foreign key constraints (informational) and liquid clustering on common filter columns.</li>
  <li>Use metric views or AI/BI dashboards for governed metrics inside Databricks, and Genie spaces for natural-language Q&amp;A on curated tables.</li>
</ul>

<h3>Power BI patterns</h3>
<table class="ref">
  <tr><th>Mode</th><th>Use for</th><th>Trade-off</th></tr>
  <tr><td>Import</td><td>Small to medium models, dimensions</td><td>Fast visuals, but data is only as fresh as the last refresh and capacity memory limits apply</td></tr>
  <tr><td>DirectQuery</td><td>Large fact tables, near-real-time needs</td><td>Every visual queries the warehouse, so size it for concurrency</td></tr>
  <tr><td>Composite / dual + aggregations</td><td>Large models where most visuals hit aggregates</td><td>The best of both, but more modelling work</td></tr>
</table>
<p>Connect with the Azure Databricks connector, using Entra ID SSO so Unity Catalog permissions (including row filters) apply to each report user. You can publish to Power BI straight from Catalog Explorer.</p>

<h3>ML and GenAI architecture</h3>
<ul>
  <li><strong>MLflow</strong> tracks experiments. Models are registered in <strong>Unity Catalog</strong> with aliases such as <code>@champion</code>.</li>
  <li><strong>Feature engineering</strong>: feature tables in UC, with online serving for low-latency lookups.</li>
  <li><strong>Model Serving</strong> hosts real-time endpoints for custom models, foundation models and external models, behind <strong>AI Gateway</strong> rate limits, guardrails and usage tracking.</li>
  <li><strong>RAG</strong>: chunk documents into a Delta table, build a <strong>Vector Search</strong> index synced from it, then serve an agent through a Model Serving endpoint. Evaluate it with MLflow before promoting.</li>
  <li><strong>Batch inference</strong>: <code>ai_query()</code> in SQL, or Spark jobs, over Delta tables.</li>
</ul>
<div class="callout"><strong>Design principle:</strong> keep data, features, models and vector indexes in the same Unity Catalog. One permission model and end-to-end lineage are the main architectural advantage over stitching separate services together.</div>
`
  },

  // ---------------------------------------------------------------- cost
  {
    id: "sa-dbu-model", domain: "sa-cost", title: "The DBU Pricing Model and Compute Choices", minutes: 10,
    body: `
<h3>How you pay</h3>
<ul>
  <li>A <strong>Databricks Unit (DBU)</strong> is a unit of processing capacity per hour. Each VM size consumes a set number of DBUs per hour.</li>
  <li>The <strong>$/DBU</strong> rate depends on the compute type (jobs, all-purpose, SQL, serverless, Model Serving, ...), the tier and any commitments.</li>
  <li><strong>Classic compute</strong>: you pay Databricks for DBUs, <em>and</em> Azure bills the VMs, disks and networking separately in your subscription.</li>
  <li><strong>Serverless</strong>: the DBU rate includes the infrastructure. There's no VM line item and no idle cluster start-up time to pay for.</li>
</ul>
<pre><code>classic cost  = nodes × DBU/h per node × hours × $/DBU   +   nodes × VM $/h × hours
serverless    = DBUs consumed × serverless $/DBU</code></pre>
<p class="muted small">Rates vary by region, tier and contract. The exercises use made-up example rates; check the Azure Databricks pricing page for real ones.</p>

<h3>Choosing compute</h3>
<table class="ref">
  <tr><th>Workload</th><th>Best fit</th><th>Why</th></tr>
  <tr><td>Scheduled production ETL</td><td>Jobs compute (classic job clusters) or serverless jobs</td><td>A much lower $/DBU than all-purpose. Exists only while the run does.</td></tr>
  <tr><td>Interactive development</td><td>Serverless notebooks, or small shared all-purpose clusters with auto-termination</td><td>All-purpose is the most expensive rate, so keep it small and short-lived</td></tr>
  <tr><td>BI and SQL</td><td>Serverless SQL warehouses</td><td>Instant start, auto-stop and scale-out</td></tr>
  <tr><td>Streaming</td><td>Declarative pipelines or jobs. Continuous only when the SLA needs it.</td><td>Triggered runs on a schedule are often far cheaper</td></tr>
</table>

<h3>Levers that change the bill</h3>
<ul>
  <li><strong>Photon</strong> has a higher DBU rate but usually finishes SQL and DataFrame work much faster. Measure total cost per run, not the rate.</li>
  <li><strong>Autoscaling</strong> and <strong>auto-termination</strong> stop paying for idle capacity.</li>
  <li><strong>Azure spot VMs</strong> for workers (with fallback to on-demand) make sense for fault-tolerant batch jobs. Keep the driver on-demand.</li>
  <li><strong>Pools</strong> cut start-up time. Idle pool instances still cost VM money, though not DBUs.</li>
  <li><strong>Reservations and commitments</strong>: Azure reserved instances for steady VM use, and Databricks pre-purchase or commit plans for DBUs.</li>
</ul>
`
  },
  {
    id: "sa-sizing", domain: "sa-cost", title: "Sizing, Governance of Spend and Monitoring", minutes: 10,
    body: `
<h3>Sizing clusters</h3>
<ul>
  <li>Start from the data: how much is read per run, how much is shuffled, and how long the run is allowed to take. Run a test at a realistic scale, then read the Spark UI.</li>
  <li><strong>Memory-bound</strong> (spill, OOM, large joins or aggregations): use memory-optimized VMs (E-series) or more workers.</li>
  <li><strong>CPU-bound</strong> (parsing, wide transformations, Photon-friendly SQL): use compute-optimized (F-series) or general-purpose (D-series) VMs.</li>
  <li>Prefer fewer, larger workers for shuffle-heavy work, and more workers for embarrassingly parallel work.</li>
  <li>Size the <strong>driver</strong> up when code collects results, broadcasts large tables, or runs many concurrent streams or notebooks.</li>
</ul>

<h3>Sizing SQL warehouses</h3>
<table class="ref">
  <tr><th>Symptom</th><th>Change</th></tr>
  <tr><td>Single complex queries are slow or spill to disk</td><td>Increase the warehouse <strong>size</strong> (scale up)</td></tr>
  <tr><td>Queries queue at peak while each runs fast on its own</td><td>Increase <strong>max clusters</strong> (scale out)</td></tr>
  <tr><td>Paying for idle time between bursts</td><td>Serverless with a short auto-stop</td></tr>
</table>

<h3>Governing spend</h3>
<ul>
  <li><strong>Compute policies</strong> limit node types, max workers, DBU/hour and auto-termination, and enforce <strong>tags</strong>. Give each team a policy instead of unrestricted cluster creation.</li>
  <li><strong>Tags</strong> (cost center, project, environment) on clusters, jobs, warehouses and serverless budget policies flow through to billing data and Azure Cost Management.</li>
  <li><strong>Budgets</strong> in the account console send alerts when spend crosses a threshold.</li>
  <li>Move scheduled work off all-purpose clusters. It's the most common and largest saving.</li>
</ul>

<h3>Monitoring cost with system tables</h3>
<pre><code>SELECT u.usage_date,
       u.custom_tags['cost_center'] AS cost_center,
       u.sku_name,
       SUM(u.usage_quantity * p.pricing.default) AS list_cost
FROM system.billing.usage u
JOIN system.billing.list_prices p
  ON u.sku_name = p.sku_name
 AND u.usage_start_time >= p.price_start_time
 AND (p.price_end_time IS NULL OR u.usage_start_time &lt; p.price_end_time)
WHERE u.usage_date >= current_date() - INTERVAL 30 DAYS
GROUP BY ALL
ORDER BY list_cost DESC;</code></pre>
<p>Join with <code>system.lakeflow.jobs</code> and <code>system.compute.clusters</code> to attribute cost to jobs and owners. <strong>Predictive optimization</strong> and liquid clustering cut storage and query cost on managed tables with no manual OPTIMIZE or VACUUM schedules.</p>
`
  },

  // ---------------------------------------------------------------- ops
  {
    id: "sa-migration", domain: "sa-ops", title: "Migration Patterns", minutes: 10,
    body: `
<h3>Migration approach</h3>
<ol>
  <li><strong>Assess</strong>: inventory sources, pipelines, reports, data volumes and dependencies. Profile the workloads to estimate DBUs.</li>
  <li><strong>Land the platform</strong>: networking, identity, Unity Catalog topology, CI/CD. Do this before the first workload.</li>
  <li><strong>Migrate by domain or use case</strong>, not as one big bang. Move the data, then the pipelines, then the consumers.</li>
  <li><strong>Run in parallel</strong> and reconcile row counts, aggregates and checksums before switching consumers.</li>
  <li><strong>Decommission</strong> the old path, or it will keep costing money and keep getting new dependencies.</li>
</ol>

<h3>Common sources</h3>
<table class="ref">
  <tr><th>From</th><th>Approach</th></tr>
  <tr><td>Hive metastore (legacy workspace tables)</td><td>Upgrade to Unity Catalog with <strong>UCX</strong> (Databricks Labs). Use <code>SYNC</code> for external tables, and CTAS or <code>DEEP CLONE</code> for managed tables. Update code to three-level names.</td></tr>
  <tr><td>Azure Synapse dedicated pools / SQL Server DWH</td><td>Land tables in Delta (Lakeflow Connect, bulk export, Federation for validation). Convert T-SQL to Databricks SQL (conversion tools help). Re-point Power BI to a SQL warehouse.</td></tr>
  <tr><td>Hadoop / HDInsight</td><td>Copy HDFS data to ADLS, convert Hive/Parquet tables to Delta, and port Spark jobs. Replace Oozie/cron with Lakeflow Jobs.</td></tr>
  <tr><td>ADF-heavy ETL</td><td>Keep ADF orchestration at first and move transformation logic into Databricks. Consolidate orchestration later where it simplifies things.</td></tr>
</table>

<h3>Risks to plan for</h3>
<ul>
  <li><strong>Semantics</strong>: SQL dialect, NULL handling, collation and case sensitivity, implicit casts.</li>
  <li><strong>Performance</strong>: queries tuned for MPP distribution keys may need liquid clustering and different join strategies.</li>
  <li><strong>Security model</strong>: map existing roles to account groups and UC grants. Re-create row-level security as row filters.</li>
  <li><strong>Cost surprises</strong>: always-on legacy habits (24×7 clusters) carried into a consumption model.</li>
</ul>
`
  },
  {
    id: "sa-dr-cicd", domain: "sa-ops", title: "Disaster Recovery, IaC and CI/CD", minutes: 11,
    body: `
<figure class="diagram">
<svg viewBox="0 0 760 300" role="img" aria-label="Terraform and Asset Bundles in Git deploy the same configuration to a primary workspace in West Europe and a standby workspace in North Europe. A scheduled deep clone job copies Delta tables from primary to secondary storage.">
  ${saArrow("a4")}${saArrow("a4x", "d-accent-fill")}
  <rect class="d-box" x="290" y="15" width="180" height="44" rx="6"/>
  <text x="380" y="42" text-anchor="middle" class="d-label">Git: Terraform + bundles</text>
  <polyline points="380,59 380,80" class="d-line"/>
  <polyline points="180,80 580,80" class="d-line"/>
  <line x1="180" y1="80" x2="180" y2="138" class="d-line" marker-end="url(#a4)"/>
  <line x1="580" y1="80" x2="580" y2="138" class="d-line" marker-end="url(#a4)"/>
  <text x="388" y="74" class="d-note">deploy both</text>

  <rect class="d-group" x="20" y="100" width="320" height="180" rx="8"/>
  <text x="36" y="122" class="d-title">West Europe (primary)</text>
  <rect class="d-box" x="45" y="140" width="270" height="44" rx="6"/>
  <text x="180" y="167" text-anchor="middle" class="d-label">workspace · jobs active</text>
  <rect class="d-box" x="45" y="210" width="270" height="44" rx="6"/>
  <text x="180" y="237" text-anchor="middle" class="d-label">ADLS Gen2 · metastore</text>

  <rect class="d-group" x="420" y="100" width="320" height="180" rx="8"/>
  <text x="724" y="122" text-anchor="end" class="d-title">North Europe (secondary)</text>
  <rect class="d-box" x="445" y="140" width="270" height="44" rx="6"/>
  <text x="580" y="167" text-anchor="middle" class="d-label">workspace · jobs paused</text>
  <rect class="d-box" x="445" y="210" width="270" height="44" rx="6"/>
  <text x="580" y="237" text-anchor="middle" class="d-label">ADLS Gen2 · metastore</text>

  <line x1="315" y1="232" x2="443" y2="232" class="d-line d-accent" marker-end="url(#a4x)"/>
  <text x="380" y="222" text-anchor="middle" class="d-note d-accent-text">DEEP CLONE</text>
  <text x="380" y="252" text-anchor="middle" class="d-note">every N hours</text>
</svg>
<figcaption>Active-passive DR: the code and configuration are redeployable anywhere from Git, and only the data has to be copied. The clone interval sets your recovery point objective.</figcaption>
</figure>

<h3>What has to be recoverable</h3>
<ul>
  <li><strong>Infrastructure and configuration</strong>: workspaces, networking, Unity Catalog objects and grants, policies. Keep them in <strong>Terraform</strong> (the <code>databricks</code> and <code>azurerm</code> providers).</li>
  <li><strong>Code and jobs</strong>: notebooks, pipelines and job definitions in Git, deployed with <strong>Databricks Asset Bundles</strong>.</li>
  <li><strong>Data</strong>: Delta tables copied to the secondary region with <code>DEEP CLONE</code> (incremental on re-run) or Delta Sharing plus a copy job. A <code>SHALLOW CLONE</code> only references the source files, so it's useless if the primary region is gone.</li>
</ul>
<div class="callout"><strong>Watch out:</strong> relying only on ADLS geo-redundant replication is risky for Delta. Replication is asynchronous and not ordered per table, so after a failover a table's transaction log and data files can be inconsistent. Prefer Delta-aware copies, such as deep clone.</div>

<h3>Choosing a strategy</h3>
<table class="ref">
  <tr><th>Strategy</th><th>RPO / RTO</th><th>Cost</th></tr>
  <tr><td>Backup &amp; redeploy (IaC only, data restored later)</td><td>Hours to days</td><td>Lowest</td></tr>
  <tr><td>Active-passive (standby workspace, scheduled data copies)</td><td>Minutes to hours (the copy interval) / hours</td><td>Storage plus copy compute</td></tr>
  <tr><td>Active-active (workloads in both regions)</td><td>Near zero</td><td>Highest, and complex for writes</td></tr>
</table>

<h3>CI/CD across environments</h3>
<ol>
  <li>Developers work in Git folders on feature branches in the dev workspace.</li>
  <li>A pull request triggers CI: unit tests, <code>databricks bundle validate</code>, deploy to a test workspace and integration tests.</li>
  <li>Merging to main deploys the bundle to <strong>prod</strong> with a <strong>service principal</strong>. Nobody deploys to prod by hand.</li>
  <li>Parameterize the catalog (<code>${"$"}{var.catalog}</code>) so the same code reads <code>sales_dev</code> in dev and <code>sales_prod</code> in prod.</li>
</ol>
`
  }
);

TRAINER.questions.push(
  // ---------------------------------------------------------------- platform
  { id: "sp1", domain: "sa-platform",
    q: "What does VNet injection require for each Azure Databricks workspace?",
    options: ["One subnet shared with other Azure services", "Two dedicated subnets (host and container), delegated to Microsoft.Databricks/workspaces, each with an NSG", "A public IP for every cluster node", "An ExpressRoute circuit"],
    answer: 1,
    explain: "Each workspace needs its own host and container subnets, delegated to Databricks and associated with network security groups. Every cluster node uses one IP in each." },
  { id: "sp2", domain: "sa-platform",
    q: "With secure cluster connectivity (No Public IP), how does the control plane manage cluster VMs?",
    options: ["Through inbound SSH from the control plane", "Each cluster opens an outbound connection to the SCC relay, and no inbound ports are open", "Through a public load balancer in the customer VNet", "Through Azure Bastion"],
    answer: 1,
    explain: "Cluster nodes have no public IPs and accept no inbound traffic. They initiate an outbound TLS tunnel to the relay." },
  { id: "sp3", domain: "sa-platform",
    q: "A bank wants users to reach the workspace UI and REST API only from its corporate network, never over the public internet. What does that need?",
    options: ["Back-end Private Link only", "Front-end Private Link (plus a browser-authentication endpoint), with public network access disabled", "A NAT gateway", "Larger subnets"],
    answer: 1,
    explain: "Front-end (user-to-workspace) Private Link covers user and API traffic. Web SSO also needs the browser-authentication private endpoint for the region." },
  { id: "sp4", domain: "sa-platform",
    q: "The storage account firewall blocks serverless SQL warehouses from reading ADLS. What's the correct fix?",
    options: ["Add the workspace VNet's subnets to the storage firewall", "Attach a network connectivity configuration (NCC) and use its private endpoints or stable subnets for the storage account", "Enable public access on the storage account", "Switch the warehouse to classic"],
    answer: 1,
    explain: "Serverless compute doesn't run in your VNet. An NCC gives it private endpoints, or subnet IDs you can allow, for your storage." },
  { id: "sp5", domain: "sa-platform",
    q: "Which component runs in the Databricks-managed control plane rather than your Azure subscription?",
    options: ["Classic cluster VMs", "The workspace's ADLS data", "The web application, job scheduler and cluster manager", "The NAT gateway"],
    answer: 2,
    explain: "The control plane hosts the web app, APIs, scheduler and cluster manager. Classic VMs and your data live in your subscription." },
  { id: "sp6", domain: "sa-platform",
    q: "Why is getting subnet size right at workspace creation important?",
    options: ["Subnet size limits how many cluster nodes the workspace can run at once, and is hard to change later", "Bigger subnets reduce DBU prices", "Subnet size sets the Spark version", "Small subnets disable Unity Catalog"],
    answer: 0,
    explain: "Every node takes one IP in each subnet, so the smaller subnet caps total concurrent nodes across all clusters in the workspace." },

  // ---------------------------------------------------------------- security
  { id: "ss1", domain: "sa-security",
    q: "What is the recommended way to manage users and groups for Azure Databricks?",
    options: ["Create users manually in each workspace", "Sync from Entra ID to the Databricks account (automatic identity management or SCIM) and assign account groups to workspaces", "Share one admin login", "Use workspace-local groups for Unity Catalog grants"],
    answer: 1,
    explain: "Account-level identities from Entra ID can be used everywhere, including in Unity Catalog grants. Workspace-local groups can't." },
  { id: "ss2", domain: "sa-security",
    q: "How should Unity Catalog access ADLS Gen2 on Azure?",
    options: ["Storage account keys in Spark config", "An Access Connector for Azure Databricks (managed identity) registered as a storage credential, with external locations", "A SAS token in each notebook", "Mount points with a personal service principal secret"],
    answer: 1,
    explain: "A managed identity has no secret to leak or rotate. UC governs the paths through external locations, and users never get storage permissions." },
  { id: "ss3", domain: "sa-security",
    q: "Which identity should run production jobs and CI/CD deployments?",
    options: ["The lead engineer's account", "A service principal using OAuth or Entra ID tokens", "A shared user account with a PAT", "The metastore admin"],
    answer: 1,
    explain: "Service principals decouple production from people. They use short-lived OAuth or Entra tokens instead of long-lived PATs." },
  { id: "ss4", domain: "sa-security",
    q: "Dev and prod workspaces share one metastore. How do you make sure production catalogs can't be accessed from the dev workspace, even by users who have grants?",
    options: ["Create a second metastore in the same region", "Workspace-catalog binding: bind prod catalogs only to prod workspaces", "Rename the catalogs", "Use a different storage account"],
    answer: 1,
    explain: "Bindings restrict which workspaces can use a catalog. Grants decide who can use it. You can only have one metastore per region." },
  { id: "ss5", domain: "sa-security",
    q: "How many Unity Catalog metastores should an account have in one Azure region?",
    options: ["One per workspace", "One per region, shared by the workspaces there", "One per business unit", "As many as you like, for isolation"],
    answer: 1,
    explain: "A metastore is regional and shared by every workspace in that region. Isolate with catalogs, bindings and grants." },
  { id: "ss6", domain: "sa-security",
    q: "Which customer-managed key option protects notebook source and secrets stored in the control plane?",
    options: ["Managed disks", "Managed services", "Workspace storage", "ADLS encryption"],
    answer: 1,
    explain: "The managed services key covers control-plane data at rest. Managed disks covers cluster VM disks, and workspace storage covers the DBFS root account." },

  // ---------------------------------------------------------------- reference
  { id: "sr1", domain: "sa-reference",
    q: "Millions of files a day land in ADLS. Which Auto Loader setup scales best?",
    options: ["Directory listing every minute", "File notification mode (Event Grid plus a storage queue) or managed file events", "COPY INTO in a loop", "A Python script with dbutils.fs.ls"],
    answer: 1,
    explain: "Notification-based discovery avoids listing huge directories. It's the scalable mode for high file volumes." },
  { id: "sr2", domain: "sa-reference",
    q: "How does Spark Structured Streaming typically read from Azure Event Hubs?",
    options: ["Through the Event Hubs Kafka-compatible endpoint with the Kafka source", "By polling Event Hubs with REST calls in a UDF", "With COPY INTO", "Through a JDBC driver"],
    answer: 0,
    explain: "Event Hubs exposes a Kafka endpoint, so the built-in Kafka source works with SASL configuration." },
  { id: "sr3", domain: "sa-reference",
    q: "A Power BI report on a 2-billion-row fact table needs data that's 5 minutes fresh. What's the best pattern?",
    options: ["Import mode refreshed every 5 minutes", "DirectQuery (or composite with aggregations) against a serverless SQL warehouse, over a gold table", "Export CSV files to SharePoint", "Query bronze directly"],
    answer: 1,
    explain: "DirectQuery keeps data fresh without huge imports. Size the warehouse for report concurrency and model gold for BI." },
  { id: "sr4", domain: "sa-reference",
    q: "Which components form a governed RAG architecture on Databricks?",
    options: ["A pandas DataFrame and a Flask app on a VM", "Chunked documents in Delta, a Vector Search index synced from them, and an agent served through Model Serving, all in Unity Catalog", "A SQL warehouse only", "Delta Sharing and Power BI"],
    answer: 1,
    explain: "Vector Search syncs from Delta tables, and Model Serving hosts the agent. Unity Catalog governs and tracks lineage for both." },
  { id: "sr5", domain: "sa-reference",
    q: "When is Lakehouse Federation the right tool?",
    options: ["For high-volume nightly ETL from SQL Server", "To query an operational database in place for exploration or migration validation", "To replicate data across regions", "To serve real-time ML features"],
    answer: 1,
    explain: "Federation pushes queries down to the source without copying data. Recurring heavy workloads should ingest into Delta instead." },
  { id: "sr6", domain: "sa-reference",
    q: "The business wants dashboards updated every 30 minutes. What is the most cost-effective streaming design?",
    options: ["A continuous pipeline running 24×7", "A triggered pipeline or availableNow job scheduled every 30 minutes", "A manual refresh button", "An all-purpose cluster that never terminates"],
    answer: 1,
    explain: "Triggered runs process only new data and then stop, which meets a 30-minute SLA without paying for always-on compute." },

  // ---------------------------------------------------------------- cost
  { id: "sc1", domain: "sa-cost",
    q: "For a classic job cluster, which costs appear on the bill?",
    options: ["Only DBUs", "Only Azure VMs", "Databricks DBUs, plus Azure VM, disk and network costs billed by Azure", "A flat monthly fee"],
    answer: 2,
    explain: "Classic compute is billed twice: DBUs by Databricks, and infrastructure by Azure. Serverless DBU rates include the infrastructure." },
  { id: "sc2", domain: "sa-cost",
    q: "Users report BI dashboards slow down only at 9 a.m., when 200 people open them. Each query on its own is fast. What should you change?",
    options: ["Increase the warehouse size", "Increase the warehouse's max clusters (scale out)", "Turn off Photon", "Use an all-purpose cluster"],
    answer: 1,
    explain: "Queuing under concurrency is solved by scaling out. Increasing the size helps individual heavy queries." },
  { id: "sc3", domain: "sa-cost",
    q: "Where should spot VMs be used in a Databricks cluster?",
    options: ["For the driver of production streaming jobs", "For workers of fault-tolerant batch jobs, with fallback to on-demand", "For every node of every cluster", "Only for SQL warehouses"],
    answer: 1,
    explain: "Spark can recompute work lost when a worker is evicted. Losing the driver kills the job, so keep it on-demand." },
  { id: "sc4", domain: "sa-cost",
    q: "Interactive clusters are left running overnight and there are no limits on node types. What's the best control?",
    options: ["Email reminders", "Compute policies that enforce auto-termination, max workers, allowed VM types and tags", "Deleting clusters weekly", "Removing everyone's workspace access"],
    answer: 1,
    explain: "Policies make the cost-safe configuration the default and enforce tags so spend can be attributed." },
  { id: "sc5", domain: "sa-cost",
    q: "Where do you analyze Databricks spend by tag and SKU with SQL?",
    options: ["system.billing.usage joined with system.billing.list_prices", "DESCRIBE HISTORY", "The Spark UI", "information_schema.tables"],
    answer: 0,
    explain: "The billing system tables record usage by SKU, workspace and tags. Joining list prices gives you cost." },
  { id: "sc6", domain: "sa-cost",
    q: "Photon has a higher DBU rate. When does enabling it reduce cost?",
    options: ["Never", "When the speed-up makes total DBU-hours drop by more than the rate increase, which is common for SQL and DataFrame workloads", "Only for Python UDF workloads", "Only on single-node clusters"],
    answer: 1,
    explain: "Compare cost per run. A large speed-up usually more than offsets the higher rate, though UDF-heavy code gains little." },

  // ---------------------------------------------------------------- ops
  { id: "so1", domain: "sa-ops",
    q: "Which Databricks Labs tool helps upgrade a workspace's Hive metastore tables and permissions to Unity Catalog?",
    options: ["UCX", "dbx", "MLflow", "Delta Sharing"],
    answer: 0,
    explain: "UCX assesses the workspace, migrates tables (for example with SYNC for external tables) and maps permissions to Unity Catalog." },
  { id: "so2", domain: "sa-ops",
    q: "Why is SHALLOW CLONE unsuitable for disaster recovery to another region?",
    options: ["It's slower than deep clone", "It references the source table's data files, so it's useless if the primary storage is lost", "It doesn't copy the schema", "It can't be queried"],
    answer: 1,
    explain: "A shallow clone copies only metadata. Deep clone copies the data files, and incrementally on later runs." },
  { id: "so3", domain: "sa-ops",
    q: "Why is ADLS geo-redundant storage alone risky for Delta tables during a regional failover?",
    options: ["GRS doesn't copy Parquet files", "Replication is asynchronous and not ordered per table, so a table's log and data files can be inconsistent after failover", "GRS deletes old versions", "Delta can't read GRS accounts"],
    answer: 1,
    explain: "Delta needs its log and data files to be consistent. Delta-aware copies (deep clone) give a consistent table in the secondary region." },
  { id: "so4", domain: "sa-ops",
    q: "In an active-passive DR design with deep clones every 4 hours, what's the approximate RPO?",
    options: ["Zero", "Up to 4 hours of data", "4 days", "It depends only on the cluster size"],
    answer: 1,
    explain: "Anything written since the last successful copy can be lost, so the copy interval roughly sets the RPO." },
  { id: "so5", domain: "sa-ops",
    q: "Which combination is recommended for infrastructure versus jobs and pipelines as code?",
    options: ["ARM templates for everything", "Terraform for workspaces, networking and Unity Catalog; Databricks Asset Bundles for jobs, pipelines and code", "Manual setup in the UI, documented in a wiki", "Asset Bundles for VNets"],
    answer: 1,
    explain: "Terraform (with the databricks and azurerm providers) manages platform resources. Bundles package and deploy workloads per environment." },
  { id: "so6", domain: "sa-ops",
    q: "What is the most important principle when migrating a large legacy warehouse?",
    options: ["Big-bang cut-over in one weekend", "Migrate incrementally by domain, run old and new in parallel, and reconcile before switching consumers", "Rewrite every report first", "Copy data without validating it"],
    answer: 1,
    explain: "Incremental, validated migration limits risk and lets the business switch over one domain at a time." }
);

TRAINER.exercises.push(
  // ---------------------------------------------------------------- scenario case studies
  {
    id: "sa-case-bank", kind: "scenario", domain: "sa-platform", level: "Medium",
    title: "Case study: a private workspace for a bank",
    brief: "<p><strong>Contoso Bank</strong> is moving risk analytics to Azure Databricks in West Europe. Security requires: no public internet path to the workspace or the data, all egress inspected by the central Azure Firewall in a hub VNet, customer-controlled encryption keys, and identities managed only in Entra ID. Peak load is about 150 concurrent cluster nodes.</p>",
    steps: [
      { q: "How should the workspace's compute network be deployed?",
        options: [
          { text: "VNet injection into a spoke VNet with secure cluster connectivity, routing egress through the hub firewall with a UDR", score: 2, feedback: "Right. VNet injection gives you control of routing and peering, SCC removes public IPs and inbound rules, and the UDR sends egress through the firewall." },
          { text: "The default Databricks-managed VNet", score: 0, feedback: "A managed VNet can't be peered into your hub or routed through your firewall the way the bank requires." },
          { text: "VNet injection without SCC, opening inbound NSG rules for the control plane", score: 0, feedback: "SCC is what removes public IPs and inbound rules. Without it, nodes are exposed, which fails the 'no public path' requirement." }
        ] },
      { q: "How big should the host and container subnets be?",
        options: [
          { text: "/24 each (251 usable addresses), comfortably above 150 nodes with room to grow", score: 2, feedback: "Right. Each node needs an IP in both subnets, and Azure reserves 5 per subnet. A /24 gives headroom for growth and new clusters." },
          { text: "/26 each", score: 0, feedback: "A /26 has 59 usable addresses, far below 150 concurrent nodes." },
          { text: "/25 for host and /27 for container", score: 0, feedback: "The smaller subnet caps the workspace. A /27 allows only 27 nodes." }
        ] },
      { q: "How do users and the control plane connect privately?",
        options: [
          { text: "Front-end and back-end Private Link, a browser-authentication private endpoint for the region, and public network access disabled", score: 2, feedback: "Right. That covers user and API traffic, cluster-to-control-plane traffic and web SSO, all privately." },
          { text: "IP access lists only", score: 1, feedback: "IP access lists restrict who can connect, but traffic still goes over public endpoints. They're useful as an extra layer, not on their own." },
          { text: "A site-to-site VPN to the Databricks control plane", score: 0, feedback: "You can't build a VPN to the control plane. Private Link is the supported private path." }
        ] },
      { q: "How do clusters and Unity Catalog reach the bank's ADLS Gen2 accounts?",
        options: [
          { text: "Private endpoints on the storage accounts, plus an Access Connector managed identity as the UC storage credential", score: 2, feedback: "Right. The network path is private, and access is granted through UC with no secrets." },
          { text: "Storage account keys in a Key Vault-backed secret scope, set in each cluster's Spark config", score: 0, feedback: "That works technically, but keys grant full account access, bypass UC governance and must be rotated." },
          { text: "Leave the storage public but restricted to the workspace's NAT IP", score: 0, feedback: "That fails the 'no public path to data' requirement." }
        ] },
      { q: "How are encryption and identity handled?",
        options: [
          { text: "CMK for managed services, managed disks and workspace storage; Entra ID synced to the account (automatic identity management or SCIM); service principals for jobs", score: 2, feedback: "Right. Customer keys cover control-plane data, VM disks and the workspace storage account, and identities live only in Entra ID." },
          { text: "Microsoft-managed keys, with users added manually in each workspace", score: 0, feedback: "That fails both requirements: keys aren't customer-controlled, and identities aren't managed centrally." },
          { text: "CMK for managed disks only, and personal access tokens for jobs", score: 1, feedback: "This is partly right, but managed services CMK is needed for control-plane data, and PATs tied to people are a production risk." }
        ] }
    ]
  },
  {
    id: "sa-case-iot", kind: "scenario", domain: "sa-reference", level: "Medium",
    title: "Case study: near-real-time retail inventory",
    brief: "<p><strong>Fabrikam Retail</strong> has 900 stores sending point-of-sale and stock events (about 20,000 events/second at peak) to Azure Event Hubs. Store managers need stock levels on Power BI dashboards that are at most <strong>2 minutes</strong> old. Finance wants a cleansed daily sales history. The data team is small.</p>",
    steps: [
      { q: "How do you ingest the events?",
        options: [
          { text: "Structured Streaming from Event Hubs through its Kafka endpoint, into a bronze streaming table", score: 2, feedback: "Right. It's a native streaming source with exactly-once checkpointing, and Event Hubs is sized for peak throughput." },
          { text: "An ADF copy activity every hour into Parquet files", score: 0, feedback: "Hourly batches can't meet a 2-minute freshness SLA." },
          { text: "A Python REST poller on a VM writing CSV files", score: 0, feedback: "That's custom code with no checkpointing or scaling, and it adds latency and operational risk." }
        ] },
      { q: "How do you build bronze to silver to gold?",
        options: [
          { text: "One Lakeflow Declarative Pipeline: streaming tables with expectations for silver, and a materialized view for gold stock levels", score: 2, feedback: "Right. A small team gets dependency management, retries, data-quality metrics and incremental refresh with very little code." },
          { text: "Three separate notebooks scheduled independently", score: 1, feedback: "This can work, but you have to handle ordering, retries and quality checks yourself, which is a lot for a small team." },
          { text: "A nightly batch job that rebuilds all tables", score: 0, feedback: "Nightly rebuilds miss the 2-minute SLA and reprocess everything each time." }
        ] },
      { q: "How should the pipeline run?",
        options: [
          { text: "Continuous mode, because a 2-minute end-to-end SLA leaves too little room for scheduled triggers and start-up time", score: 2, feedback: "Right. With a strict SLA, continuous processing keeps latency in seconds. Revisit this if the SLA relaxes." },
          { text: "Triggered every 15 minutes", score: 0, feedback: "Cheaper, but data could be over 15 minutes old, which breaks the SLA." },
          { text: "Triggered every minute on a new job cluster each time", score: 0, feedback: "Cluster start-up alone takes minutes, so each run would miss the SLA." }
        ] },
      { q: "How do store dashboards get the data?",
        options: [
          { text: "Power BI DirectQuery to a serverless SQL warehouse over the gold table, scaled out for store-opening peaks", score: 2, feedback: "Right. DirectQuery shows fresh data, and serverless scale-out absorbs peaks." },
          { text: "Power BI Import mode refreshed every 2 minutes", score: 0, feedback: "Import refreshes that often are impractical and hit service limits." },
          { text: "Let Power BI query the bronze table on an all-purpose cluster", score: 0, feedback: "Bronze is raw and unmodelled, and all-purpose compute is the most expensive way to serve BI." }
        ] },
      { q: "Finance needs a cleansed daily sales history. Where does it come from?",
        options: [
          { text: "Another gold table (or materialized view) built from the same silver tables", score: 2, feedback: "Right. One silver layer feeds both the real-time and the finance gold tables. One version of the truth, no duplicate ingestion." },
          { text: "A separate ingestion of the same events by another team", score: 0, feedback: "Duplicate pipelines diverge, cost twice as much, and give two answers to the same question." },
          { text: "Export silver to Excel every night", score: 0, feedback: "That loses governance and lineage, and doesn't scale." }
        ] }
    ]
  },
  {
    id: "sa-case-governance", kind: "scenario", domain: "sa-security", level: "Hard",
    title: "Case study: governance for three business units",
    brief: "<p><strong>Northwind Group</strong> has Sales, HR and Supply Chain units in one Azure region, each with dev and prod workspaces. HR data contains salaries and must never be visible to other units, or from dev workspaces. Sales wants to share a product catalogue with an external distributor that uses Snowflake. Auditors want to know who accessed salary columns.</p>",
    steps: [
      { q: "How many metastores?",
        options: [
          { text: "One metastore for the region, attached to all six workspaces", score: 2, feedback: "Right. A metastore is regional. Isolation comes from catalogs, grants and bindings." },
          { text: "One metastore per business unit", score: 0, feedback: "You can only have one metastore per region. Splitting would also block cross-unit sharing and central governance." },
          { text: "No Unity Catalog; keep each workspace's Hive metastore", score: 0, feedback: "That fragments governance and gives you no central audit or lineage." }
        ] },
      { q: "How do you lay out catalogs?",
        options: [
          { text: "A catalog per unit and environment (sales_dev, sales_prod, hr_dev, hr_prod, ...), each with its own managed storage location", score: 2, feedback: "Right. Units own their catalogs and storage, and the environment is a parameter in the code." },
          { text: "One catalog called main with a schema per unit", score: 1, feedback: "This can work for small setups, but per-unit storage, ownership and environment isolation are harder." },
          { text: "A catalog per user", score: 0, feedback: "That's unmanageable and breaks sharing." }
        ] },
      { q: "How do you keep HR prod data out of dev workspaces and other units?",
        options: [
          { text: "Bind hr_prod only to the HR prod workspace, and grant it only to HR account groups", score: 2, feedback: "Right. The binding blocks it at the workspace level, and grants control who can use it." },
          { text: "Rely on grants only", score: 1, feedback: "Grants are essential, but without a binding a mistaken grant would expose prod data in dev workspaces." },
          { text: "Hide the catalog by giving it an obscure name", score: 0, feedback: "Obscurity isn't access control." }
        ] },
      { q: "How do you protect salary columns inside HR?",
        options: [
          { text: "A column mask (or ABAC policy on a governed 'pii' tag) that shows salaries only to an hr_compensation group, with access audited through system tables", score: 2, feedback: "Right. Fine-grained control on a single table, enforced everywhere, with system.access.audit and lineage for auditors." },
          { text: "Copy the table without salaries for everyone else", score: 1, feedback: "This works, but every copy has to be maintained, and copies drift." },
          { text: "Tell analysts not to query the column", score: 0, feedback: "That isn't a control." }
        ] },
      { q: "How does Sales share the product catalogue with the Snowflake-based distributor?",
        options: [
          { text: "Open Delta Sharing: a share with the product tables and a recipient for the distributor", score: 2, feedback: "Right. It's live, read-only access with no copies, works on platforms other than Databricks, and can be revoked at any time." },
          { text: "Nightly CSV exports to an SFTP server", score: 0, feedback: "Stale copies with no governance, and another pipeline to run." },
          { text: "Give the distributor a Databricks user account in the Sales workspace", score: 0, feedback: "External parties shouldn't get workspace accounts just to read data." }
        ] }
    ]
  },
  {
    id: "sa-case-migration", kind: "scenario", domain: "sa-ops", level: "Hard",
    title: "Case study: migrating a Synapse warehouse",
    brief: "<p><strong>Tailspin Insurance</strong> runs a 40 TB Azure Synapse dedicated SQL pool with 600 stored procedures, ADF orchestration and 300 Power BI reports. Older Databricks workspaces still use the Hive metastore with mount points. Leadership wants to retire Synapse within 12 months with no reporting outage.</p>",
    steps: [
      { q: "What is the overall migration approach?",
        options: [
          { text: "Land the platform first (network, identity, Unity Catalog, CI/CD), then migrate domain by domain with parallel runs", score: 2, feedback: "Right. Foundations first, then incremental and validated moves that the business can absorb." },
          { text: "Big-bang: copy everything and switch every report over one weekend", score: 0, feedback: "With 600 procedures and 300 reports, a big bang almost guarantees outages and a rollback." },
          { text: "Rewrite all 300 reports first, then move the data", score: 0, feedback: "Reports depend on the data. Move the data and pipelines first, then re-point consumers." }
        ] },
      { q: "What do you do with the legacy Hive metastore workspaces?",
        options: [
          { text: "Upgrade to Unity Catalog with UCX: SYNC external tables, clone or CTAS managed tables, and replace mounts with external locations", score: 2, feedback: "Right. UCX automates assessment and migration, including permissions." },
          { text: "Leave them as they are and build only new workloads on UC", score: 1, feedback: "This is sometimes a first step, but two governance models run side by side indefinitely." },
          { text: "Keep mount points and add the storage key to every cluster", score: 0, feedback: "Mounts with shared keys bypass governance, which is exactly what UC replaces." }
        ] },
      { q: "How do you move the Synapse data and logic?",
        options: [
          { text: "Bulk-load history into Delta, ingest increments with Lakeflow Connect or pipelines, convert T-SQL to Databricks SQL with conversion tooling, and keep ADF triggering jobs at first", score: 2, feedback: "Right. Data first, logic converted with tools, and orchestration changes kept to a minimum during cut-over." },
          { text: "Query Synapse through Lakehouse Federation from Databricks permanently", score: 0, feedback: "Federation is great for validation, but permanently keeping Synapse defeats the goal of retiring it." },
          { text: "Rewrite all 600 procedures by hand in PySpark", score: 1, feedback: "This is possible, but slow and risky. Convert to SQL first and refactor selectively." }
        ] },
      { q: "How do you prove the new tables are correct before switching reports?",
        options: [
          { text: "Run both systems in parallel and reconcile row counts, key aggregates and checksums per table and report", score: 2, feedback: "Right. Automated reconciliation builds trust and catches dialect and NULL-semantics differences." },
          { text: "Spot-check a few reports by eye", score: 0, feedback: "That misses subtle differences that show up later in financial numbers." },
          { text: "Trust the conversion tool", score: 0, feedback: "Tools speed up conversion. They don't prove the results match." }
        ] },
      { q: "Where do the 300 Power BI reports connect after migration?",
        options: [
          { text: "Serverless SQL warehouses over gold tables, using Entra ID SSO so UC permissions and row filters apply", score: 2, feedback: "Right. Governed, elastic BI serving that replaces the Synapse endpoint." },
          { text: "All-purpose clusters through ODBC", score: 0, feedback: "Expensive and not built for BI concurrency." },
          { text: "Exported Parquet files in OneDrive", score: 0, feedback: "That loses freshness and governance." }
        ] }
    ]
  },
  {
    id: "sa-case-cost", kind: "scenario", domain: "sa-cost", level: "Medium",
    title: "Case study: cutting a runaway Databricks bill",
    brief: "<p>A platform team's monthly spend doubled in a quarter. Findings: nightly ETL runs on shared all-purpose clusters, many interactive clusters have no auto-termination, a classic SQL warehouse runs 24×7 for dashboards used 8–18h on weekdays, and nobody can say which team spends what.</p>",
    steps: [
      { q: "What do you do first?",
        options: [
          { text: "Make spend visible: enforce tags (team, project) and build reports from system.billing.usage and list_prices", score: 2, feedback: "Right. You can't prioritize or hold teams accountable without attribution." },
          { text: "Cut every cluster to 2 workers", score: 0, feedback: "Blind cuts break SLAs and don't address where the money actually goes." },
          { text: "Buy a bigger commitment discount", score: 1, feedback: "Commitments lower the rate, but you'd be committing to waste. Fix usage first." }
        ] },
      { q: "What about the nightly ETL on all-purpose clusters?",
        options: [
          { text: "Move it to jobs compute or serverless jobs", score: 2, feedback: "Right. Jobs compute has a much lower $/DBU, and compute exists only while the job runs. This is usually the single biggest saving." },
          { text: "Keep it, but run it on a bigger all-purpose cluster to finish faster", score: 0, feedback: "That's still the most expensive SKU." },
          { text: "Run it on the SQL warehouse", score: 0, feedback: "Notebook and Python ETL doesn't belong on a SQL warehouse." }
        ] },
      { q: "How do you control interactive clusters?",
        options: [
          { text: "Compute policies per team: auto-termination (for example 30 minutes), max workers, allowed VM types, mandatory tags", score: 2, feedback: "Right. Guardrails by default, with no manual policing." },
          { text: "A weekly email asking people to stop clusters", score: 0, feedback: "That doesn't reliably change behaviour." },
          { text: "Ban interactive clusters entirely", score: 0, feedback: "That blocks development. Serverless notebooks or policy-limited clusters are the balance." }
        ] },
      { q: "What about the 24×7 classic SQL warehouse?",
        options: [
          { text: "Switch to a serverless SQL warehouse with a short auto-stop, and scale out at peak", score: 2, feedback: "Right. You pay only while queries run, with instant start for the first user in the morning." },
          { text: "Keep it running but downsize it", score: 1, feedback: "That's cheaper per hour, but you still pay for 14 idle hours a day and weekends." },
          { text: "Move dashboards to an all-purpose cluster", score: 0, feedback: "That's more expensive and less suited to BI." }
        ] },
      { q: "How do you keep it under control afterwards?",
        options: [
          { text: "Account budgets with alerts per team, a monthly cost review from the system-table dashboard, and predictive optimization on managed tables", score: 2, feedback: "Right. Continuous visibility and automation stop costs from creeping back." },
          { text: "A one-off clean-up project", score: 0, feedback: "Without ongoing monitoring, the same habits come back." },
          { text: "Restrict the platform to one team", score: 0, feedback: "That trades cost for value and pushes teams to shadow IT." }
        ] }
    ]
  },

  // ---------------------------------------------------------------- sizing and cost calculations
  {
    id: "sa-calc-subnet", kind: "calc", domain: "sa-platform", level: "Easy",
    title: "Subnet capacity for VNet injection",
    prompt: "<p>A workspace was deployed with a <code>/25</code> host subnet and a <code>/26</code> container subnet. Every cluster node takes one IP in <strong>each</strong> subnet, and Azure reserves 5 addresses in every subnet.</p><ol><li>How many cluster nodes can run at the same time across the whole workspace?</li><li>A new workspace must support 200 concurrent nodes. What is the largest prefix length (for example 24 for <code>/24</code>) that both subnets could use?</li></ol>",
    answers: [
      { label: "Max concurrent nodes", unit: "nodes", value: 59, tol: 0 },
      { label: "Largest prefix for 200 nodes", unit: "/n", value: 24, tol: 0 }
    ],
    hints: ["A /n subnet has 2^(32 − n) addresses. Subtract the 5 reserved ones.", "The smaller of the two subnets limits the workspace.", "You need 200 + 5 = 205 addresses. Which power of two is the first to fit?"],
    explanation: "<p>/25 = 128 − 5 = 123 usable, and /26 = 64 − 5 = 59 usable. The smaller subnet wins, so the workspace can run <strong>59</strong> nodes.</p><p>200 nodes need 205 addresses. A /25 has 128, which isn't enough, and a /24 has 256, so the answer is <strong>/24</strong> (prefix 24). In practice, add headroom for growth.</p>"
  },
  {
    id: "sa-calc-job", kind: "calc", domain: "sa-cost", level: "Medium",
    title: "Monthly cost of a nightly job on classic compute",
    prompt: "<p>A nightly ETL job runs on a job cluster with <strong>1 driver + 8 workers</strong>. Each node consumes <strong>1.5 DBU/hour</strong> and its Azure VM costs <strong>$0.50/hour</strong>. The job runs <strong>2.5 hours</strong> every day for <strong>30 days</strong>. Assume an example jobs-compute rate of <strong>$0.30 per DBU</strong>.</p><ol><li>How many DBUs does the job consume per month?</li><li>What is the total monthly cost (DBUs + VMs) in dollars?</li></ol><p class=\"muted small\">The rates are made up for practice. Real prices depend on region, tier and contract.</p>",
    answers: [
      { label: "DBUs per month", unit: "DBU", value: 1012.5, tol: 0.5 },
      { label: "Total monthly cost", unit: "$", value: 641.25, tol: 0.5 }
    ],
    hints: ["Nodes = driver + workers = 9.", "DBUs = nodes × DBU/h × hours per day × days.", "Classic compute pays for DBUs and VMs: add nodes × $/h × hours × days."],
    explanation: "<p>DBUs = 9 × 1.5 × 2.5 × 30 = <strong>1,012.5</strong>. DBU cost = 1,012.5 × $0.30 = $303.75.</p><p>VM cost = 9 × $0.50 × 2.5 × 30 = $337.50. Total = $303.75 + $337.50 = <strong>$641.25</strong>. On classic compute the Azure VM bill is often as big as the Databricks bill.</p>"
  },
  {
    id: "sa-calc-allpurpose", kind: "calc", domain: "sa-cost", level: "Easy",
    title: "Savings from moving to jobs compute",
    prompt: "<p>The same job (1,012.5 DBUs a month) has been running on an <strong>all-purpose</strong> cluster at an example rate of <strong>$0.55 per DBU</strong>, instead of jobs compute at <strong>$0.30 per DBU</strong>. VM costs are the same either way.</p><ol><li>How much does moving it to jobs compute save per month, in dollars?</li><li>By what percentage does the <em>DBU</em> cost fall?</li></ol>",
    answers: [
      { label: "Monthly saving", unit: "$", value: 253.125, tol: 0.5 },
      { label: "DBU cost reduction", unit: "%", value: 45.45, tol: 0.3 }
    ],
    hints: ["Saving = DBUs × (all-purpose rate − jobs rate).", "Percentage = (old − new) / old × 100."],
    explanation: "<p>Saving = 1,012.5 × ($0.55 − $0.30) = <strong>$253.13</strong> a month.</p><p>Reduction = 0.25 / 0.55 = <strong>45.5%</strong> of the DBU cost. Multiply that across every scheduled job on all-purpose clusters and it's often the single largest saving.</p>"
  },
  {
    id: "sa-calc-warehouse", kind: "calc", domain: "sa-cost", level: "Medium",
    title: "SQL warehouse scale-out and monthly cost",
    prompt: "<p>Dashboards peak at <strong>75 concurrent queries</strong>. Assume each warehouse cluster comfortably handles <strong>10 concurrent queries</strong> and consumes <strong>24 DBU/hour</strong>, at an example serverless rate of <strong>$0.70 per DBU</strong> (infrastructure included). Over the business day the warehouse averages <strong>3 running clusters</strong> for <strong>10 hours</strong> a day, <strong>22 days</strong> a month, and auto-stops otherwise.</p><ol><li>What max cluster setting covers the peak?</li><li>What is the monthly cost in dollars?</li></ol>",
    answers: [
      { label: "Max clusters", unit: "clusters", value: 8, tol: 0 },
      { label: "Monthly cost", unit: "$", value: 11088, tol: 1 }
    ],
    hints: ["Round up: you can't run part of a cluster.", "DBUs = average clusters × DBU/h × hours × days."],
    explanation: "<p>75 / 10 = 7.5, so you need <strong>8</strong> clusters at peak.</p><p>DBUs = 3 × 24 × 10 × 22 = 15,840. Cost = 15,840 × $0.70 = <strong>$11,088</strong>. Running the same warehouse 24×7 at 3 clusters would use 3 × 24 × 24 × 30 = 51,840 DBUs, more than three times as much.</p>"
  },
  {
    id: "sa-calc-eventhubs", kind: "calc", domain: "sa-reference", level: "Medium",
    title: "Sizing Event Hubs for a streaming source",
    prompt: "<p>Stores send <strong>18,000 events/second</strong> at peak, averaging <strong>0.4 KB</strong> each. In the Event Hubs Standard tier, one throughput unit (TU) allows ingress of up to <strong>1 MB/second or 1,000 events/second</strong>, whichever limit is reached first.</p><ol><li>What is the peak ingress in MB/second (1 MB = 1,000 KB)?</li><li>How many throughput units are needed at peak?</li></ol>",
    answers: [
      { label: "Peak ingress", unit: "MB/s", value: 7.2, tol: 0.25 },
      { label: "Throughput units", unit: "TUs", value: 18, tol: 0 }
    ],
    hints: ["Bytes per second = events/s × event size.", "Work out the TUs needed for each limit and take the larger."],
    explanation: "<p>18,000 × 0.4 KB = 7,200 KB/s = <strong>7.2 MB/s</strong>, so 8 TUs would cover the bandwidth.</p><p>The event-rate limit needs 18,000 / 1,000 = <strong>18 TUs</strong>. Small events hit the event limit first. Also plan the partition count, which caps how many consumers (Spark tasks) can read in parallel.</p>"
  }
);
