// The tiered list of Simple Icons logos the pack carries (Plan C Decision 9).
//
// Simple Icons holds over 3,400 brands, which does not fit the 4 MB pack beside the cloud
// sets. This list is the brands developers draw in architecture and database diagrams:
// databases, languages and runtimes, cloud and hosting providers, queues and streams, CI/CD and
// source hosting, containers and orchestration, observability, auth and identity, API and
// protocol tools, web and backend frameworks, data and ML tools, developer tools and operating
// systems. Consumer, social, retail, media, automotive and finance brands stay out unless a
// developer integrates with them (Stripe and PayPal are in).
//
// Tiers run oldest to newest. If the pack goes over its size target, trim the last tier first;
// never raise the cap. The first tier is the 219 brands of the earlier pack, all kept.
//
// A slug that Simple Icons has removed, or whose own licence the pack does not bundle (see
// COLLECT.simple in pack-icons.mjs), is skipped by the build and counted there.
//
// Coverage check (a one-off, read-only comparison with a competitor's list of 595 tech logo
// names): 404 of the 595 have a Simple Icons twin in this list (matched by slug, title or alias;
// the rest are cloud, general or company marks, or logos Simple Icons has removed).
//
// 763 slugs in all.

/** Today's brands, kept in every later list. */
export const OLD_BRANDS = [
  "mysql", "postgresql", "sqlite", "mariadb", "mongodb", "redis", "elasticsearch", "opensearch",
  "apachecassandra", "cockroachlabs", "neo4j", "influxdb", "clickhouse", "snowflake", "databricks",
  "apachekafka", "rabbitmq", "apachepulsar", "natsdotio", "apachespark", "apacheflink",
  "apacheairflow", "apachehadoop", "duckdb", "supabase", "firebase", "planetscale", "neon",
  "prisma", "timescale", "couchbase", "trino", "presto", "docker", "kubernetes", "helm",
  "terraform", "ansible", "pulumi", "vault", "hashicorp", "consul", "nomad", "packer", "vagrant",
  "nginx", "apache", "apachetomcat", "caddy", "traefikproxy", "envoyproxy", "istio", "linkerd",
  "cloudflare", "fastly", "akamai", "vercel", "netlify", "digitalocean", "vultr", "hetzner", "ovh",
  "alibabacloud", "openstack", "github", "gitlab", "bitbucket", "git", "jenkins", "circleci",
  "travisci", "githubactions", "argo", "spinnaker", "tekton", "jfrog", "sonatype", "npm", "pnpm",
  "yarn", "pypi", "gradle", "prometheus", "grafana", "datadog", "newrelic", "sentry", "splunk",
  "elastic", "kibana", "logstash", "fluentd", "fluentbit", "jaeger", "opentelemetry", "pagerduty",
  "opsgenie", "statuspage", "nodedotjs", "deno", "bun", "python", "go", "rust", "openjdk",
  "kotlin", "scala", "dotnet", "php", "ruby", "swift", "typescript", "javascript", "elixir",
  "erlang", "haskell", "clojure", "cplusplus", "c", "lua", "perl", "r", "dart", "flutter", "react",
  "vuedotjs", "angular", "svelte", "nextdotjs", "nuxt", "remix", "astro", "vite", "webpack",
  "express", "nestjs", "fastify", "django", "flask", "fastapi", "rubyonrails", "laravel", "spring",
  "springboot", "quarkus", "graphql", "apollographql", "swagger", "openapiinitiative", "postman",
  "insomnia", "kong", "auth0", "okta", "keycloak", "stripe", "paypal", "mailgun", "mailchimp",
  "discord", "zoom", "jira", "confluence", "notion", "trello", "asana", "linear", "figma",
  "anthropic", "huggingface", "tensorflow", "pytorch", "langchain", "ollama", "jupyter", "pandas",
  "numpy", "apachesuperset", "metabase", "looker", "redash", "airbyte", "mixpanel",
  "googleanalytics", "algolia", "meilisearch", "minio", "ceph", "cloudinary", "contentful",
  "strapi", "sanity", "wordpress", "shopify", "sap", "hubspot", "zapier", "n8n", "linux", "ubuntu",
  "debian", "redhat", "centos", "alpinelinux", "macos", "apple", "android", "ios", "raspberrypi",
  "arduino", "celery", "temporal", "camunda", "wireguard", "openvpn", "tailscale", "letsencrypt",
  "1password", "bitwarden",
];

// Tier: databases and data stores (48).
const TIER_1 = [
  "apachecouchdb", "apachehbase", "apachedruid", "apachehive", "apacheparquet", "apachearrow",
  "apacheavro", "apachelucene", "apachesolr", "arangodb", "dgraph", "rocksdb", "etcd", "tidb",
  "vitess", "scylladb", "surrealdb", "fauna", "convex", "turso", "nhost", "pocketbase", "appwrite",
  "directus", "hasura", "drizzle", "typeorm", "sequelize", "mongoose", "sqlalchemy", "hibernate",
  "liquibase", "flyway", "dbeaver", "phpmyadmin", "adminer", "beekeeperstudio", "h2database",
  "cloudera", "teradata", "googlebigquery", "googlebigtable", "googlecloudspanner",
  "googlecloudstorage", "googlepubsub", "singlestore", "milvus", "qdrant",
];

// Tier: programming languages and runtimes (21).
const TIER_2 = [
  "ada", "crystal", "elm", "fortran", "fsharp", "gleam", "julia", "nim", "ocaml", "odin",
  "purescript", "racket", "solidity", "zig", "webassembly", "wasmer", "assemblyscript",
  "coffeescript", "latex", "typst", "d3",
];

// Tier: build tools, compilers and package managers (29).
const TIER_3 = [
  "poetry", "uv", "anaconda", "composer", "packagist", "apachemaven", "apacheant", "bazel",
  "cmake", "llvm", "rollupdotjs", "esbuild", "swc", "turborepo", "nx", "biome", "babel", "eslint",
  "prettier", "stylelint", "postcss", "autoprefixer", "ruff", "semanticrelease", "homebrew",
  "chocolatey", "nixos", "flatpak", "gnu",
];

// Tier: web and backend frameworks (52).
const TIER_4 = [
  "reactquery", "redux", "mobx", "preact", "solid", "pinia", "vuetify", "ngrx", "ionic",
  "capacitor", "gatsby", "qwik", "lit", "alpinedotjs", "htmx", "stimulus", "jquery", "threedotjs",
  "apacheecharts", "plotly", "mapbox", "tailwindcss", "bootstrap", "mui", "expo", "nativescript",
  "electron", "meteor", "trpc", "socketdotio", "hono", "pydantic", "gunicorn", "sidekiq",
  "symfony", "springsecurity", "jhipster", "ktor", "gin", "actix", "tokio", "phoenixframework",
  "drupal", "woocommerce", "hugo", "jekyll", "docusaurus", "gitbook", "sphinx", "ghost",
  "payloadcms", "vitepress",
];

// Tier: cloud, hosting and network providers (33).
const TIER_5 = [
  "googlecloud", "baidu", "scaleway", "equinixmetal", "flydotio", "render", "railway",
  "cloudflarepages", "cloudflareworkers", "githubpages", "denodeploy", "coolify", "caprover",
  "bunnydotnet", "cloudfoundry", "redhatopenshift", "apachecloudstack", "proxmox", "vmware",
  "dell", "cisco", "junipernetworks", "paloaltonetworks", "fortinet", "f5", "netapp", "citrix",
  "ubiquiti", "mikrotik", "synology", "openwrt", "ngrok", "zerotier",
];

// Tier: queues, streams and workflows (10).
const TIER_6 = [
  "apacherocketmq", "mqtt", "eclipsemosquitto", "apachestorm", "apachenifi", "prefect", "pusher",
  "dapr", "nodered", "make",
];

// Tier: containers, orchestration and infrastructure as code (18).
const TIER_7 = [
  "podman", "containerd", "k3s", "rancher", "opentofu", "chef", "puppet", "saltproject", "haproxy",
  "cilium", "knative", "falco", "trivy", "openfaas", "serverless", "sst", "portainer", "cpanel",
];

// Tier: CI/CD, source hosting and code quality (26).
const TIER_8 = [
  "drone", "buildkite", "codemagic", "fastlane", "gitea", "forgejo", "codeberg", "sourcehut",
  "subversion", "perforce", "gitkraken", "githubcopilot", "dependabot", "renovate",
  "sonarqubecloud", "sonarqubeserver", "codecov", "coveralls", "codeclimate", "codacy",
  "checkmarx", "fossa", "snyk", "dependencycheck", "owasp", "openbao",
];

// Tier: observability and operations (15).
const TIER_9 = [
  "dynatrace", "sumologic", "appsignal", "posthog", "betterstack", "uptimekuma", "icinga",
  "netdata", "thanos", "graylog", "backstage", "k6", "locust", "gatling", "apachejmeter",
];

// Tier: authentication, identity and security (25).
const TIER_10 = [
  "authelia", "authentik", "clerk", "fusionauth", "betterauth", "passport", "jsonwebtokens", "ory",
  "vaultwarden", "lastpass", "dashlane", "proton", "protonvpn", "mullvad", "nordvpn", "openssl",
  "snort", "burpsuite", "metasploit", "wireshark", "hackerone", "bugcrowd", "virustotal", "yubico",
  "webauthn",
];

// Tier: API, protocol and integration tools (14).
const TIER_11 = [
  "bruno", "hoppscotch", "httpie", "curl", "webrtc", "bluetooth", "zigbee", "rss", "openid",
  "modelcontextprotocol", "intercom", "zendesk", "helpscout", "brevo",
];

// Tier: data, analytics and machine learning (35).
const TIER_12 = [
  "scipy", "scikitlearn", "polars", "dask", "ray", "keras", "onnx", "mlflow", "kaggle",
  "googlecolab", "streamlit", "gradio", "dash", "langgraph", "lmstudio", "claude", "claudecode",
  "googlegemini", "mistralai", "perplexity", "deepseek", "nvidia", "replicate", "roboflow",
  "ultralytics", "opencv", "mediapipe", "spacy", "weightsandbiases", "talend", "qlik", "matomo",
  "plausibleanalytics", "umami", "googletagmanager",
];

// Tier: developer tools, editors and collaboration (54).
const TIER_13 = [
  "vscodium", "androidstudio", "intellijidea", "pycharm", "webstorm", "phpstorm", "goland",
  "rubymine", "clion", "rider", "datagrip", "resharper", "eclipseide", "vim", "neovim", "helix",
  "zedindustries", "sublimetext", "notepadplusplus", "warp", "iterm2", "tmux", "alacritty", "zsh",
  "gnubash", "windsurf", "cursor", "codesandbox", "stackblitz", "gitpod", "jsfiddle", "observable",
  "jetbrains", "sketch", "diagramsdotnet", "mermaid", "miro", "obsidian", "mattermost", "element",
  "googlemeet", "storybook", "chromatic", "puppeteer", "cypress", "selenium", "jest", "vitest",
  "mocha", "chai", "testinglibrary", "webdriverio", "cucumber", "appium",
];

// Tier: operating systems and hardware (27).
const TIER_14 = [
  "rockylinux", "almalinux", "archlinux", "opensuse", "suse", "gentoo", "kalilinux", "linuxmint",
  "popos", "freebsd", "openbsd", "googlechrome", "firefox", "firefoxbrowser", "safari", "opera",
  "brave", "vivaldi", "espressif", "homeassistant", "platformio", "ros", "arm", "riscv", "amd",
  "intel", "qualcomm",
];

// Tier: payments, commerce and business tools (27).
const TIER_15 = [
  "braintree", "adyen", "square", "klarna", "razorpay", "paddle", "lemonsqueezy", "wise",
  "revolut", "coinbase", "binance", "bitcoin", "ethereum", "solana", "chainlink", "ethers",
  "web3dotjs", "bigcommerce", "squarespace", "wix", "webflow", "framer", "airtable", "dropbox",
  "box", "googledrive", "gmail",
];

// Tier: more web libraries, template engines and UI kits (32).
const TIER_16 = [
  "tanstack", "xstate", "vueuse", "swr", "immer", "formik", "i18next", "axios", "nodemon",
  "handlebarsdotjs", "ejs", "pug", "nunjucks", "jinja", "dotenv", "zod", "vapor", "vaadin",
  "primefaces", "primeng", "primevue", "astra", "gsap", "greensock", "framework7", "uikit",
  "aurelia", "refine", "redwoodjs", "appsmith", "budibase", "baserow",
];

// Tier: virtualisation, self-hosted tools and foundations (19).
const TIER_17 = [
  "qemu", "virtualbox", "wine", "openzfs", "cncf", "linuxfoundation", "openjsfoundation", "hcl",
  "gitforwindows", "htop", "gstreamer", "ffmpeg", "libreoffice", "onlyoffice", "nextcloud",
  "owncloud", "syncthing", "rclone", "seafile",
];

// Tier: maps, geodata and decentralised storage (11).
const TIER_18 = [
  "openstreetmap", "googlemaps", "googleearthengine", "esri", "arcgis", "qgis", "gdal",
  "geopandas", "folium", "cesium", "ipfs",
];

// Tier: gaps the coverage check found: web platform, productivity and developer services (48).
const TIER_19 = [
  "html5", "jamstack", "lodash", "pm2", "pytest", "rasa", "recoil", "retool", "upstash",
  "shadcnui", "googleappsscript", "googleplay", "appstore", "markdown", "json", "yaml", "unity",
  "webgl", "blender", "replit", "elevenlabs", "resend", "nextdns", "atlassian", "meta", "google",
  "loom", "stackoverflow", "mozilla", "gnome", "applepay", "googlepay", "googlecalendar",
  "googledocs", "googlesheets", "googleforms", "googlechat", "googletranslate", "uipath",
  "livekit", "umbraco", "rocketdotchat", "moodle", "odoo", "deepgram", "yolo", "matillion",
  "braintrust",
];

/** Every slug in tier order: the old brands first, the newest tier last. */
export const BRANDS = [
  ...OLD_BRANDS,
  ...TIER_1,
  ...TIER_2,
  ...TIER_3,
  ...TIER_4,
  ...TIER_5,
  ...TIER_6,
  ...TIER_7,
  ...TIER_8,
  ...TIER_9,
  ...TIER_10,
  ...TIER_11,
  ...TIER_12,
  ...TIER_13,
  ...TIER_14,
  ...TIER_15,
  ...TIER_16,
  ...TIER_17,
  ...TIER_18,
  ...TIER_19,
];
