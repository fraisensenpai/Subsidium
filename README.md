# Subsidium — Faz 1 + Faz 2 (Retrieval) + Faz 3 (AI Provider + Editing) İskeleti

Bu, kararlaştırılan yığına (Tauri + Rust + React/TS + tree-sitter + SQLite)
göre oluşturulmuş **Faz 1** (workspace intelligence) ve **Faz 2** (retrieval)
iskeletidir.

## Bu iskelette olan

- **Frontend (`src/`)**: Workspace seçme butonu, dosya gezgini (tree view), ve
  "Project Intelligence" paneli (tarama + indeks istatistikleri). Layout, sonraki
  fazlarda gelecek code editor / agent chat / terminal / diff paneli için yer
  ayrılmış şekilde tasarlandı.
- **Workspace tarama (`src-tauri/src/workspace/`)**: `ignore` crate ile
  `.gitignore` kurallarına saygılı, ayrıca `node_modules`, `.git`, `target`,
  `dist`, `__pycache__` gibi klasörleri gitignore'dan bağımsız olarak da atlayan
  bir tarayıcı. Sonucu hem düz dosya listesine hem UI için ağaç yapısına
  dönüştürüyor.
- **Parsing (`src-tauri/src/parsing/`)**: tree-sitter ile Rust, JavaScript,
  TypeScript/TSX ve Python için fonksiyon/class/struct/enum/interface/type
  sembol çıkarımı. Yeni bir dil eklemek = yeni bir grammar bağımlılığı +
  `treesitter.rs`'e bir query — mimari değişmiyor.
- **Indexing (`src-tauri/src/indexing/`)**: Workspace başına
  `<workspace>/.subsidium/index.db` altında SQLite indeksi (`files`, `symbols`,
  `symbols_fts`, ve ileriki fazlar için hazır duran boş `edges` tablosu).
  İçerik hash'i değişmeyen dosyalar atlanarak **incremental indexing**
  yapılıyor.
- **Tauri komutları (`src-tauri/src/commands.rs`)**: `open_workspace` tüm
  pipeline'ı (tara → parse et → indeksle) tek seferde çalıştırıp UI'nin
  ihtiyaç duyduğu ağacı, tarama özetini ve indeks istatistiklerini döndürüyor.
- **Retrieval (`src-tauri/src/retrieval/`)** — Faz 2: `search_workspace`
  komutu üç yöntemi birleştirip tek, sıralanmış bir sonuç listesi döndürüyor:
  - **Sembol adı arama**: `symbols` tablosunda LIKE ile substring eşleşmesi
  - **Dosya adı arama**: `files` tablosunda yol substring eşleşmesi
  - **Tam metin arama**: indekslenmiş her dosyayı diskten canlı okuyup
    (içerik veritabanında ayrıca tutulmuyor — spec'in "kaynak kodun
    tamamını düz metin halinde saklama" uyarısına uygun) satır satır arama
  - Sorgu önce `retrieval::tokenize` ile identifier token'larına ayrılıyor
    (`camelCase`/`snake_case` farkında), böylece doğal dil sorguları da
    (`"token neden kayboluyor"`) ilgili sembol/dosya adlarını yakalayabiliyor.
  - UI'de orta paneldeki **Search** kutusu bunu doğrudan çağırıyor —
    henüz bir AI modeline bağlı değil, sonuçlar ham olarak gösteriliyor;
    böylece bir sonraki fazda Context Engine'i buna bağlamadan önce
    retrieval kalitesini gerçek workspace'lerde gözlemleyebiliyorsun.

## Bu iskelette olmayan (bilinçli olarak — sonraki fazlar)

Semantic/embedding index, dependency/reference graph (`edges` tablosu
şemada hazır ama boş), terminal komutları için zaman aşımı (bkz.
`agent::run_shell` içindeki not — bir komut asılırsa agent turn'ü de asılı
kalır), çok adımlı/paralel tool call'ların aynı anda işlenmesi, gerçek
Git işlemleri (commit/push/branch — bilinçli olarak eklenmedi, spec
"kullanıcı adına geri döndürülemez işlemler izinsiz yapılmamalı" diyor;
şu an yalnızca salt-okunur `git status`/`git diff` var).

## Arayüz ve UX güncellemeleri (bu turda eklenenler)

- **Resizable panel sistemi**: Sabit piksel genişlikli 3 sütun yerine
  `react-resizable-panels` ile gerçek, sürüklenebilir panel sistemi geldi
  (Explorer / Editor / sağ dock). Bu aynı zamanda önceki bir bug'ı da
  çözdü: uzun bir kod satırı editörü CSS grid'de genişletip sağdaki Agent
  panelini görünüm dışına itebiliyordu (`min-w-0` eksikliği + CodeMirror'da
  satır kaydırma olmaması) — artık editör satırları sarıyor ve panel'ler
  taşmıyor.
- **Görsel dil**: Mor/gradient "AI ürünü" paletinden uzaklaşıp koyu
  grafit + kehribar/pirinç tonlu, geliştirici aracı hissi veren bir
  palete geçildi (`tailwind.config.js`). Her yerde BÜYÜK HARF etiket
  kullanımı azaltıldı (şablon/demo hissi veren en belirgin işaretlerden
  biriydi).
- **Sohbet geçmişi**: Agent konuşmaları artık workspace'in
  `.subsidium/index.db`'sinde kalıcı (`conversations` /
  `conversation_messages` tabloları). Agent panelindeki **History**
  butonuyla geçmiş konuşmaları listeleyip açabiliyor, silebiliyorsun.
  Geçmiş bir konuşmayı açtıktan sonra mesaj göndermeye devam edersen o
  konuşma güncellenir (yeni bir tane oluşturulmaz).
- **Alt bilgi**: Sayfanın en altında ortalanmış küçük "Made by
  FraisenSenpai with ❤️" yazısı.

## Gemini'ye özel düzeltme

Bazı Gemini "thinking" modelleri, bir `functionCall`'a eşlik eden
`thoughtSignature` alanının bir sonraki turda aynen geri gönderilmesini
zorunlu tutuyor, yoksa 400 hatası veriyor. `ToolCall` artık bu alanı
taşıyor (yalnızca Gemini dolduruyor, diğer sağlayıcılarda hep `None`) ve
`gemini.rs` bunu functionCall part'ının yanında geri gönderiyor.

## Bu turda eklenenler — Onboarding, çoklu provider, tema, thinking

- **İlk açılış (onboarding)**: Hiç provider yoksa uygulama ana ekran yerine
  tam sayfa bir kurulum ekranı gösteriyor — en az bir tane ekleyene kadar
  devam edilemiyor, **kaç tane ekleyeceğin tamamen sana kalmış** ("+ Add
  another provider" ile istediğin kadar hesap ekleyebilirsin).
- **Çoklu provider desteği**: Artık tek bir `provider.json` yerine
  `providers.json` içinde bir **liste** var (her hesabın kendi `id`'si,
  ismi, sağlayıcı tipi, modeli), her hesabın API key'i keychain'de kendi
  `id`'sine göre ayrı tutuluyor. **AI Settings** artık tek form değil, tam
  bir yönetici: hesapları listele, birini "active" yap (agent hep aktif
  olanı kullanır), düzenle, sil.
- **Açık/koyu tema**: Sağ üstteki güneş/ay butonuyla değiştiriliyor,
  tercih `localStorage`'da kalıcı. Renkler CSS custom property'leri
  üzerinden geliyor (`styles.css`), Tailwind bunlara `rgb(var(--c-x) /
  <alpha-value>)` ile bağlanıyor — tema değişince tüm `bg-accent`,
  `text-muted` vb. class'lar otomatik güncelleniyor.
- **Marka rengi**: "Subsidium" yazısı ve başlıktaki nokta artık sabit koyu
  yeşil (`text-brand` / `bg-brand`) — temadan bağımsız, her zaman aynı
  yeşil tonu.
- **Thinking (düşünme süreci)**: Agent panelinde asistan mesajlarının
  üstünde "▸ thinking…" diye açılabilir bir bölüm var. Bu **best-effort
  ve sağlayıcıya göre değişken**:
  - **Gemini**: `thinkingConfig.includeThoughts: true` ile açıkça
    istiyoruz, model destekliyorsa geliyor.
  - **Ollama**: `"think": true` ile istiyoruz (deepseek-r1, qwq gibi
    reasoning modellerinde çalışır, diğerlerinde yok sayılır).
  - **OpenAI-uyumlu**: Standart değil; bazı gateway'ler (OpenRouter gibi)
    `reasoning` alanı döndürürse pasif olarak yakalanıyor, istemiyoruz.
  - **Anthropic**: Extended thinking bilinçli olarak **açılmadı** — tool
    use ile birlikte kullanıldığında signature doğrulama kuralları var ve
    canlı test olmadan doğru yapmak riskli; şu an bu sağlayıcıda thinking
    hiç gelmiyor.
- **Hangi modelle konuştuğun**: Agent panelinin üst çubuğunda artık aktif
  hesabın adı + o anki turu gerçekten yanıtlayan model görünüyor.

## Faz 5'te eklenenler — Diff Review + Git

- **Diff/review akışı**: Agent bir `write_file` önerdiğinde, onay
  kartında artık sadece "N byte yazılacak" değil, diskteki mevcut
  içerikle önerilen içerik arasındaki **gerçek satır satır diff**
  gösteriliyor (`similar` crate ile hesaplanıyor — eklenen satırlar yeşil,
  silinenler kırmızı). Kullanıcı neyin değişeceğini görmeden onay
  vermiyor.
- **Git entegrasyonu**: İki yeni salt-okunur agent aracı —
  `git_status` ve `git_diff` — model değişiklik önermeden önce mevcut
  çalışma durumunu görebiliyor (spec'in "agent değişikliklerden önce
  mevcut durumu anlayabilmeli" gereksinimi). Ayrıca sağ panelde ayrı bir
  **Git** sekmesi var — kullanıcı bağımsız olarak "Refresh" ile
  `git status`/`git diff` çıktısını görebiliyor. Git komutları sistem
  `git`'ini shell üzerinden çağırıyor (git2 gibi bir crate eklemedik);
  repo değilse veya git kurulu değilse sert hata vermek yerine bunu
  metin olarak bildiriyor.
- **Bilinçli olarak eklenmeyen**: commit/push/branch gibi geri
  dönüşü zor ya da uzak repo'yu etkileyen Git işlemleri — spec bunları
  kullanıcı kontrolünde tutmayı istiyor, otomatik/agent-tetiklemeli
  olarak eklenmedi.

## Faz 4'te eklenenler — Agent tool loop

- **Tool-calling desteği (`src-tauri/src/providers/`)**: `AiProvider`
  trait'ine `send_agent_turn` eklendi — dört provider'ın da (Anthropic,
  Gemini, OpenAI-uyumlu, Ollama) kendi tool-calling şemasına çeviren bir
  implementasyonu var. Sağlayıcılar arası format farkları ciddi (Anthropic
  `tool_use`/`tool_result` content block'ları, OpenAI `tool_calls` +
  JSON-string argümanlar, Gemini `functionCall`/`functionResponse`, Ollama
  OpenAI'a benzer ama argümanlar zaten obje) — her biri kendi dosyasında
  izole, `agent`/`commands` katmanı bu farkları hiç görmüyor.
- **Agent modülü (`src-tauri/src/agent/mod.rs`)**: Beş araç tanımlı —
  `read_file`, `list_files`, `search_code` (salt okunur, otomatik
  çalışıyor) ve `write_file`, `run_command` (**kullanıcı onayı
  gerektiriyor**). `run_command` platforma göre `cmd /C` (Windows) veya
  `sh -c` (diğer) ile workspace root'unda çalışıyor — **bilinen sınır: bir
  zaman aşımı yok**, girdi bekleyen bir komut agent turn'ünü asılı bırakır.
- **Onay akışı**: Model `write_file`/`run_command` istediğinde loop
  duruyor, sağdaki **Agent** panelinde bir onay kartı çıkıyor
  (**Approve**/**Deny**). Onaylanırsa araç çalışıyor ve sonucu modele
  geri besleniyor (agent devam ediyor); reddedilirse model "kullanıcı
  reddetti" bilgisini alıp devam ediyor — sessizce iptal olmuyor.
  `write_file` onaylanıp çalıştığında, o dosya editörde açıksa otomatik
  yeniden yükleniyor.
- **Oturum token toplamı**: Agent panelinin üstünde konuşma boyunca
  toplanan input/output token sayısı görünüyor (Faz 3'teki tekil-çağrı
  gösteriminin üzerine, artık kümülatif).
- **Adım limiti**: Bir kullanıcı mesajı en fazla `agent::MAX_STEPS` (12)
  provider round-trip'i tetikleyebilir — model aynı salt-okunur aracı
  sonsuz çağırırsa loop kendini durdurup kullanıcıya haber veriyor.

## Faz 3'te eklenenler

- **AI Provider katmanı (`src-tauri/src/providers/`)**: `AiProvider` trait'i
  + dört implementasyon (`anthropic.rs`, `gemini.rs` — Google'ın native
  `generateContent` API'si, OpenAI şemasından farklı olduğu için ayrı bir
  implementasyon —, `openai_compatible.rs` — çoğu ticari API bu şemaya
  uyduğu için tek implementasyon çoğunu kapsıyor —, `ollama.rs`).
  Sağlayıcı ayarları (hangi sağlayıcı, base URL, model)
  `<OS config dizini>/subsidium/provider.json`'da; **API key hiçbir zaman
  diske yazılmıyor**, OS'in native credential store'una (`keyring` crate —
  Windows Credential Manager) yazılıyor. Sağ üstteki **AI Settings**
  butonundan sağlayıcı seçip key/model girip **Test Connection** ile
  doğrulayabilirsin — her yanıt hangi modelin cevap verdiğini ve
  input/output token sayısını da gösteriyor (`AiResponse` — ileride agent
  tool loop'unda oturum boyunca toplam token kullanımını buradan
  biriktireceğiz).
- **Kod editleme sistemi**: Explorer'da bir dosyaya tıklayınca ortadaki
  panelde CodeMirror tabanlı bir editör açılıyor (dile göre syntax
  highlighting: TS/TSX/JS/Python/Rust/JSON/HTML/CSS/Markdown). `Ctrl+S`
  veya **Save** butonuyla `write_file` komutu dosyayı diske yazıyor ve
  arkasından o dosyayı tek başına yeniden indeksliyor (`reindex_file`) —
  tam workspace taraması yapmadan search/symbol sonuçları güncel kalıyor.
  Bu, ileride agent'ın önerdiği değişiklikleri onaylayıp uygulayacağın
  diff/review akışının da üzerine kurulacağı aynı yazma yolu.

### Faz 3 kurulum notu

`npm install` bu sefer CodeMirror paketlerini de indirecek. Rust tarafında
yeni bağımlılıklar (`reqwest`, `keyring`, `dirs`, `async-trait`) ilk
`npm run tauri dev` çalıştırmasında otomatik inecek — biraz daha derleme
süresi ekleyecek ama tek seferlik.

## Kurulum

```bash
npm install
npm run tauri icon path/to/logo.png   # gerçek uygulama ikonlarını üretir
                                        # (src-tauri/tauri.conf.json bunları bekliyor)
npm run tauri dev
```

Gereksinimler: Rust toolchain (stable), Node.js, ve Tauri'nin platforma özgü
sistem bağımlılıkları (Windows: WebView2 — genelde zaten kurulu; Linux:
`webkit2gtk`, `libayatana-appindicator3` vb. — bkz. Tauri v2 "Prerequisites"
dokümantasyonu; macOS: ek bir şey gerekmiyor).

## Not

`src-tauri/src/parsing/treesitter.rs` içindeki tree-sitter grammar crate'lerinin
giriş fonksiyonları (`LANGUAGE`, `LANGUAGE_TYPESCRIPT` vb.) sürüm sürüm
değişebiliyor; `cargo build` burada bir sembol bulamazsa ilgili crate'in
docs.rs sayfasına bakıp yalnızca bu dosyayı güncellemek yeterli — geri kalan
mimari buna bağlı değil. Bu iskelet, GUI/webview kütüphaneleri barındırmayan bu
sandbox ortamında derlenerek doğrulanmadı; kendi makinende `npm run tauri dev`
ile ilk çalıştırmayı yapman gerekiyor.
