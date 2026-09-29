#!/usr/bin/env node
/**
 * Mod arşivi aynalayıcı — SADECE BÜYÜR, ASLA SİLMEZ.
 *
 * NE YAPAR
 *
 * Kaynak depodaki (RuneForge-Mod-Storage) dosya indeksini okur, bizim
 * manifestimizle karşılaştırır ve YALNIZCA yeni dosyaları kendi
 * depolarımıza kopyalar.
 *
 * Kaynaktan bir mod SİLİNİRSE bizden silinmez: manifeste
 * `gone_from_source` olarak işaretlenir, dosya yerinde kalır. Arşivin
 * bütün amacı bu — kaynak bir gün kapanırsa ya da bir yazar modunu
 * geri çekerse kütüphanemizde boşluk oluşmasın.
 *
 * NEDEN KLONLAMIYORUZ
 *
 * Kaynak 56 GB. GitHub Actions makinelerinde ne o kadar disk var ne de
 * zaman. Bunun yerine Git Data API kullanılıyor: dosya indirilir, blob
 * olarak yüklenir, bir çalıştırmadaki tüm blob'lar TEK ağaç ve TEK
 * commit'te toplanır. Depo hiç klonlanmaz.
 *
 * DEPO BÖLME
 *
 * GitHub depo başına 5 GB öneriyor (sert sınır değil ama büyüyünce
 * uyarı geliyor). Bu yüzden hedef depolar sırayla dolduruluyor: biri
 * REPO_LIMIT_GB'ı geçince sonraki kullanılıyor. Hangi dosyanın hangi
 * depoda olduğu manifestte yazıyor.
 *
 * PARÇALI ÇALIŞMA
 *
 * --max-files ve --max-bytes ile her çalıştırma sınırlanıyor. Haftalık
 * senkron için birkaç yüz MB yeterli. İlk doldurmada betiği bitene
 * kadar tekrar tekrar çalıştırmak gerekiyor (aşağıdaki döngüye bak) —
 * böylece tek bir dev işlem yerine kaldığı yerden devam eden küçük
 * adımlar oluyor.
 *
 * KULLANIM
 *
 *   GITHUB_TOKEN=... node sync.mjs --max-files 300 --max-bytes 800MB
 *   GITHUB_TOKEN=... node sync.mjs --dry-run
 *
 *   # ilk doldurma: bitene kadar tekrarla
 *   while GITHUB_TOKEN=... node sync.mjs --max-bytes 1GB; do sleep 5; done
 */

import { Buffer } from 'node:buffer'

// ── Ayarlar ──────────────────────────────────────────────────────────
const OWNER = process.env.MIRROR_OWNER || 'Spryzenweb'

/** Hedef depolar, sırayla doldurulur. Dolunca listeye yenisini ekle. */
const TARGET_REPOS = (process.env.MIRROR_REPOS || 'autrex-mods-1')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean)

/** Manifest ilk depoda durur; küçük bir JSON. */
const MANIFEST_REPO = TARGET_REPOS[0]
const MANIFEST_PATH = 'manifest.json'
const BRANCH = 'main'

const SOURCE_REPO = 'MelancholySlime/RuneForge-Mod-Storage'
const SOURCE_INDEX = `https://raw.githubusercontent.com/${SOURCE_REPO}/main/_runeforge_files.json`
const SOURCE_RAW = `https://raw.githubusercontent.com/${SOURCE_REPO}/main/`

/**
 * Kapak resimleri dosya indeksinde YOK; RuneForge API'sindeki
 * `thumbnailKey` alanından geliyor ve ayrı bir CDN'de duruyor.
 * Bu yüzden ayrı bir aşama olarak aynalanıyorlar.
 */
const SOURCE_API = 'https://runeforge.dev/api/mods'
const SOURCE_IMG = 'https://r2-images-prod.runeforge.dev/'
const IMAGE_DIR = 'images/'
/** API sayfa boyutu sabit 24; `limit` parametresi yok sayılıyor. */
const PAGE_SIZE = 24

/**
 * Depo başına hedef üst sınır.
 *
 * GitHub'ın SERT sınırı yalnızca dosya başına 100 MB. Depo boyutu için
 * 5 GB tavsiye ediliyor ve üstüne çıkınca dostane bir e-posta gelebiliyor,
 * ama yayınlanmış bir kesme noktası yok — kaynak depo 56 GB ile çalışıyor.
 *
 * 20 GB, tavsiyenin makul üstünde kalırken kaynağın tamamının (56 GB)
 * üç depoya sığmasını sağlıyor. Yine de yetmezse aşağıdaki otomatik
 * depo açma devreye giriyor.
 */
const REPO_LIMIT_GB = Number(process.env.MIRROR_REPO_LIMIT_GB || 20)

/**
 * Blob API'sinin pratik dosya sınırı.
 *
 * GitHub'ın belgelenmiş sert sınırı dosya başına 100 MB ama o, git ile
 * push edilen dosyalar için. Blob API'sinde içerik base64 gönderiliyor
 * (%33 şişme) ve istek gövdesi çok daha erken doluyor: sahada 422
 * "Sorry, your input was too large to process" alındı.
 *
 * Sınırı ölçtük: 37 MB geçiyor, 40 MB geçmiyor — yani gövde sınırı
 * base64 şişmesiyle ~50 MB'a denk geliyor. 36 MB güvenli payla altında
 * kalıyor. Üstündekiler manifeste `too_large` yazılıp atlanıyor ve site
 * onlar için kaynağın adresine düşüyor.
 *
 * Bu sınır YALNIZCA API yolu için geçerli. Git ile push edilen dosyalarda
 * böyle bir kısıt yok (orada sert sınır 100 MB), o yüzden 36 MB üstü
 * dosyalar ancak yerel bir klon + push geçişiyle arşive girebilir.
 */
const MAX_FILE_BYTES = Number(process.env.MIRROR_MAX_FILE_MB || 36) * 1024 * 1024

const API = 'https://api.github.com'
const TOKEN = process.env.GITHUB_TOKEN || ''

// ── Argümanlar ───────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)

const parseBytes = (v, fallback) => {
  if (!v) return fallback
  const m = String(v).match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i)
  if (!m) return fallback
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[(m[2] || 'B').toUpperCase()]
  return Math.floor(Number(m[1]) * mult)
}

const MAX_FILES = Number(flag('max-files', '400'))
const MAX_BYTES = parseBytes(flag('max-bytes'), 900 * 1024 * 1024)
const DRY_RUN = has('dry-run')

// ── Küçük yardımcılar ────────────────────────────────────────────────
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB'
const log = (...a) => console.log(...a)

async function gh(path, options = {}) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'autrex-mod-mirror',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(options.headers || {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub ${res.status} ${path}\n${body.slice(0, 300)}`)
  }
  return res.status === 204 ? null : res.json()
}

/**
 * Sınırlı eşzamanlılıkla eşle.
 *
 * Her şey sıralıydı: bir dosya inip bitmeden sonraki başlamıyor, bir blob
 * yüklenmeden sonraki gitmiyordu. İş tamamen ağ beklemesi olduğu için
 * bu, boşa geçen zaman demekti. Eşzamanlılık sınırlı tutuluyor: GitHub'ın
 * ikincil hız sınırları (çok hızlı içerik oluşturma) tetiklenmesin.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/** Kaynaktan indirme eşzamanlılığı. */
const DL_CONCURRENCY = Number(process.env.MIRROR_DL_CONCURRENCY || 10)
/** GitHub'a blob yükleme eşzamanlılığı — ikincil sınırlar için daha düşük. */
const UP_CONCURRENCY = Number(process.env.MIRROR_UP_CONCURRENCY || 6)

/** Ağ hataları geçici olabiliyor; birkaç kez dene. */
async function retry(fn, tries = 4, waitMs = 2000) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (i === tries - 1) break
      /*
       * GitHub ikincil hız sınırına takıldığında 403/429 dönüyor.
       * Bunlarda normalden çok daha uzun beklemek gerekiyor, yoksa
       * arka arkaya aynı duvara çarpıyoruz.
       */
      const msg = String(e?.message || '')
      const throttled = msg.includes('403') || msg.includes('429') || /rate limit/i.test(msg)
      const wait = throttled ? 20000 * (i + 1) : waitMs * (i + 1)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw last
}

// ── Manifest ─────────────────────────────────────────────────────────
const emptyManifest = () => ({
  version: 1,
  source: SOURCE_REPO,
  updated_at: null,
  repo_bytes: {},   // depo adı → yaklaşık bayt
  files: {},        // kaynak yolu → kayıt
  images: {},       // thumbnailKey → kayıt
  image_keys: [],   // API taramasının önbelleği
  image_total: 0,
  images_crawled_at: null,
})

async function loadManifest() {
  const url = `https://raw.githubusercontent.com/${OWNER}/${MANIFEST_REPO}/${BRANCH}/${MANIFEST_PATH}`
  const res = await fetch(url, { headers: { 'User-Agent': 'autrex-mod-mirror' } })
  if (!res.ok) {
    log('manifest bulunamadı, sıfırdan başlanıyor')
    return emptyManifest()
  }
  try {
    const m = await res.json()
    return { ...emptyManifest(), ...m }
  } catch {
    log('manifest okunamadı, sıfırdan başlanıyor')
    return emptyManifest()
  }
}

/**
 * Sırada yeri olan ilk depo.
 *
 * Hepsi dolduysa sıradakini KENDİSİ AÇMAYA çalışır (autrex-mods-4, -5…).
 * Bu yalnızca depo açma yetkisi olan bir jetonla mümkün: Actions'ın kendi
 * GITHUB_TOKEN'i ne yeni depo açabiliyor ne de başka depoya yazabiliyor.
 * Jeton yoksa son depoya yazmaya devam edilir ve neden olduğu loglanır —
 * arşiv durmaz, sadece tek depoda büyür.
 */
async function pickRepo(manifest) {
  const limit = REPO_LIMIT_GB * 1024 ** 3

  for (const repo of TARGET_REPOS) {
    if ((manifest.repo_bytes[repo] || 0) < limit) return repo
  }

  // Hepsi dolu: sıradakini aç
  const next = nextRepoName(TARGET_REPOS.at(-1))
  if (!next) {
    log(`UYARI: depo adı türetilemedi, ${TARGET_REPOS.at(-1)} kullanılmaya devam ediyor`)
    return TARGET_REPOS.at(-1)
  }

  try {
    await gh(`/repos/${OWNER}/${next}`)
    log(`depolar doldu → ${next} zaten var, oraya geçiliyor`)
  } catch {
    log(`depolar doldu → ${next} açılıyor`)
    try {
      await gh('/user/repos', {
        method: 'POST',
        body: JSON.stringify({
          name: next,
          private: false,
          description: 'Autrex mod arşivi — sadece büyür, silinmez',
          auto_init: false,
        }),
      })
    } catch (e) {
      log(
        `yeni depo açılamadı (${e.message.split('\n')[0]}). ` +
          `Depo açma yetkisi olan bir jeton gerekiyor; ` +
          `${TARGET_REPOS.at(-1)} kullanılmaya devam ediyor.`,
      )
      return TARGET_REPOS.at(-1)
    }
  }

  TARGET_REPOS.push(next)
  manifest.repo_bytes[next] = manifest.repo_bytes[next] || 0
  return next
}

/** "autrex-mods-3" → "autrex-mods-4" */
function nextRepoName(name) {
  const m = String(name || '').match(/^(.*?)(\d+)$/)
  if (!m) return null
  return m[1] + (Number(m[2]) + 1)
}

// ── Git Data API ile toplu yazma ─────────────────────────────────────
/**
 * Bir depoya birden çok dosyayı TEK commit'te yazar.
 * entries: [{ path, contentBase64 }]
 */
/**
 * Bomboş bir depoya Git Data API ile blob yazılamıyor:
 * "Git Repository is empty" (409). Contents API ise boş depoda çalışıp
 * varsayılan dalı oluşturuyor. Bu yüzden ilk commit'i oradan atıyoruz.
 */
const initialized = new Set()
async function ensureRepoInitialized(repo) {
  if (initialized.has(repo)) return
  const base = `/repos/${OWNER}/${repo}`
  try {
    await gh(`${base}/git/ref/heads/${BRANCH}`)
    initialized.add(repo)
    return
  } catch {
    // dal yok, oluştur
  }

  const readme = [
    `# ${repo}`,
    '',
    'Autrex mod arşivi. Bu depo otomatik doldurulur.',
    '',
    'Kaynaktan kaldırılan içerik buradan **silinmez** — arşivin amacı bu.',
    'Dosya dizini: `manifest.json` (autrex-mods-1).',
    '',
    'Üreten: `tools/mod-mirror/sync.mjs`',
  ].join('\n')

  await gh(`${base}/contents/README.md`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'depo başlatıldı',
      content: Buffer.from(readme, 'utf8').toString('base64'),
      branch: BRANCH,
    }),
  })
  log(`  ${repo}: ilk commit atıldı`)
  initialized.add(repo)
}

/** Tek ağaçta kaç girdi olacağı. Büyük ağaçlarda GitHub 502 dönüyor. */
const TREE_CHUNK = 40

async function commitFiles(repo, entries, message) {
  if (!entries.length) return null
  await ensureRepoInitialized(repo)
  const base = `/repos/${OWNER}/${repo}`

  let lastSha = null
  const rejected = []

  // 265 girdilik tek ağaç denendi, GitHub 502 döndü. Parçalara bölüp
  // her parçayı kendi commit'inde işliyoruz; her parça bir öncekinin
  // üstüne biniyor, yani sonuç aynı ama istekler küçük kalıyor.
  for (let i = 0; i < entries.length; i += TREE_CHUNK) {
    const chunk = entries.slice(i, i + TREE_CHUNK)

    /*
     * Tek bir dosyanın reddedilmesi bütün turu öldürmemeli.
     *
     * Sahada bu oldu: 250 dosya / 2,3 GB indirildi, bir tanesi 422 verdi
     * ve turun tamamı çöpe gitti. Artık sorunlu dosya atlanıp geri kalan
     * yazılıyor; atlananlar çağırana bildiriliyor.
     */
    const results = await mapLimit(chunk, UP_CONCURRENCY, async (e) => {
      try {
        const blob = await retry(() =>
          gh(`${base}/git/blobs`, {
            method: 'POST',
            body: JSON.stringify({ content: e.contentBase64, encoding: 'base64' }),
          }),
        )
        return { path: e.path, mode: '100644', type: 'blob', sha: blob.sha }
      } catch (err) {
        log(`    atlandı (yüklenemedi): ${e.path} — ${String(err.message).split('\n')[0]}`)
        rejected.push(e.path)
        return null
      }
    })
    const tree = results.filter(Boolean)
    if (!tree.length) continue

    // Dal ucunu her parçada yeniden oku: bir önceki parça onu ilerletti.
    const ref = await retry(() => gh(`${base}/git/ref/heads/${BRANCH}`))
    const parent = ref.object.sha
    const parentCommit = await retry(() => gh(`${base}/git/commits/${parent}`))

    const newTree = await retry(() =>
      gh(`${base}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree }),
      }),
    )

    const commit = await retry(() =>
      gh(`${base}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message, tree: newTree.sha, parents: [parent] }),
      }),
    )

    await retry(() =>
      gh(`${base}/git/refs/heads/${BRANCH}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha }),
      }),
    )

    lastSha = commit.sha
    if (entries.length > TREE_CHUNK) {
      log(`    ${Math.min(i + TREE_CHUNK, entries.length)}/${entries.length}`)
    }
  }

  return { sha: lastSha, rejected }
}

/**
 * API'yi sayfalayarak bütün kapak resmi anahtarlarını toplar.
 * Sayfa boyutu sabit 24; `limit` parametresi yok sayılıyor, `page` çalışıyor.
 */
async function fetchAllThumbnailKeys() {
  const keys = new Set()
  let page = 1
  let total = null

  while (true) {
    let data
    try {
      data = await retry(async () => {
        const r = await fetch(`${SOURCE_API}?page=${page}`, {
          headers: { 'User-Agent': 'autrex-mod-mirror' },
        })
        if (!r.ok) throw new Error(`api ${r.status}`)
        return r.json()
      }, 2, 1500)
    } catch (e) {
      /*
       * Son sayfanın ötesini isteyince API 500 "Requested range not
       * satisfiable" dönüyor — hata değil, liste bitti demek. `total`
       * sayfa boyutuna tam bölünmediği için hesapla durmak güvenilir
       * değil (129. sayfada 1 kayıt var, 130 patlıyor).
       */
      log(`  sayfa ${page} alınamadı (${e.message}), liste bitti sayılıyor`)
      break
    }

    const mods = Array.isArray(data.mods) ? data.mods : []
    if (total === null) total = Number(data.total || 0)
    if (!mods.length) break

    for (const m of mods) {
      const k = String(m.thumbnailKey || '').trim()
      if (k && !/^https?:\/\//i.test(k)) keys.add(k.replace(/^\/+/, ''))
    }

    if (mods.length < PAGE_SIZE) break
    page++
    if (page > 1000) break
  }
  return { keys: [...keys], total }
}

/** Kapak resimlerini aynala. Mod dosyalarından ayrı, kendi bütçesiyle. */
async function syncImages(manifest) {
  log('\n── kapak resimleri ──')

  /*
   * Anahtar listesi manifestte saklanıyor.
   *
   * Tarama 129 sayfa istek demek ve her turda baştan yapılıyordu: 60 turluk
   * bir çalıştırmada ~7.700 gereksiz istek. Liste saatlerce değişmediği için
   * 3 saatten taze olanı yeniden kullanıyoruz. Yeni modları kaçırmamak için
   * süre dolunca yine taranıyor.
   */
  const CRAWL_TTL_MS = 3 * 60 * 60 * 1000
  const cachedAt = manifest.images_crawled_at ? Date.parse(manifest.images_crawled_at) : 0
  const fresh = Date.now() - cachedAt < CRAWL_TTL_MS && Array.isArray(manifest.image_keys)

  let keys, total
  if (fresh) {
    keys = manifest.image_keys
    total = manifest.image_total || keys.length
    log(`anahtar listesi önbellekten (${keys.length} kapak)`)
  } else {
    ;({ keys, total } = await fetchAllThumbnailKeys())
    manifest.image_keys = keys
    manifest.image_total = total
    manifest.images_crawled_at = new Date().toISOString()
  }

  log(`API: ${total} mod | benzersiz kapak: ${keys.length} | arşivde: ${Object.keys(manifest.images).length}`)

  const missing = keys.filter((k) => !manifest.images[k])
  if (!missing.length) {
    log('kapak resimleri güncel.')
    return 0
  }
  log(`eksik: ${missing.length}`)
  if (DRY_RUN) return missing.length

  const repo = await pickRepo(manifest)
  const batch = []
  let bytes = 0

  const queue = missing.slice(0, MAX_FILES * 2)
  for (let i = 0; i < queue.length; i += DL_CONCURRENCY) {
    if (batch.length >= MAX_FILES || bytes >= MAX_BYTES) break
    const slice = queue.slice(i, i + DL_CONCURRENCY)
    const results = await mapLimit(slice, DL_CONCURRENCY, async (key) => {
      const url = SOURCE_IMG + key.split('/').map(encodeURIComponent).join('/')
      try {
        const buf = await retry(async () => {
          const r = await fetch(url, { headers: { 'User-Agent': 'autrex-mod-mirror' } })
          if (!r.ok) throw new Error(`indirilemedi ${r.status}`)
          return Buffer.from(await r.arrayBuffer())
        }, 2, 1500)
        return { key, buf }
      } catch (e) {
        return { key, error: e.message }
      }
    })
    for (const r of results) {
      if (r.error) { log(`  atlandı: ${r.key} — ${r.error}`); continue }
      if (r.buf.length > MAX_FILE_BYTES) continue
      batch.push({ key: r.key, buffer: r.buf })
      bytes += r.buf.length
    }
  }

  if (!batch.length) return missing.length

  log(`${batch.length} resim / ${mb(bytes)} yükleniyor → ${repo}`)
  const res = await commitFiles(
    repo,
    batch.map((b) => ({ path: IMAGE_DIR + b.key, contentBase64: b.buffer.toString('base64') })),
    `arşiv: ${batch.length} yeni kapak resmi`,
  )

  // Yüklenemeyenleri manifeste yazma; sonraki turda tekrar denensin.
  const failed = new Set((res.rejected || []).map((p) => p.slice(IMAGE_DIR.length)))
  const now = new Date().toISOString()
  for (const b of batch) {
    if (failed.has(b.key)) continue
    manifest.images[b.key] = {
      repo,
      size: b.buffer.length,
      first_seen: now,
      raw_url: `https://raw.githubusercontent.com/${OWNER}/${repo}/${BRANCH}/${IMAGE_DIR}${encodeURIComponent(b.key)}`,
      // Küçük dosyalar için jsDelivr gerçek bir CDN; hız sınırı derdi yok.
      cdn_url: `https://cdn.jsdelivr.net/gh/${OWNER}/${repo}@${BRANCH}/${IMAGE_DIR}${encodeURIComponent(b.key)}`,
    }
  }
  manifest.repo_bytes[repo] = (manifest.repo_bytes[repo] || 0) + bytes
  log(`kalan resim: ${missing.length - batch.length}`)
  return missing.length - batch.length
}

// ── Ana akış ─────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN && !DRY_RUN) {
    console.error('GITHUB_TOKEN gerekli (depolara yazma yetkisi olan bir token).')
    process.exit(1)
  }

  log(`kaynak : ${SOURCE_REPO}`)
  log(`hedef  : ${OWNER}/{${TARGET_REPOS.join(', ')}}`)
  log(`sınır  : ${MAX_FILES} dosya / ${mb(MAX_BYTES)} bu çalıştırmada\n`)

  const srcRes = await fetch(SOURCE_INDEX, { headers: { 'User-Agent': 'autrex-mod-mirror' } })
  if (!srcRes.ok) throw new Error(`kaynak indeks okunamadı: ${srcRes.status}`)
  const srcIndex = await srcRes.json()
  const srcFiles = Array.isArray(srcIndex.files) ? srcIndex.files : []
  if (!srcFiles.length) throw new Error('kaynak indeks boş görünüyor, işlem durduruldu')

  const manifest = await loadManifest()
  const known = manifest.files

  /*
   * Resimler önce: toplamı birkaç yüz MB ve sitede en görünür şey onlar.
   * Kaynak düşerse bozuk mod dosyası sessizce fark edilir, bozuk kapak
   * grid'i anında göze batar.
   */
  if (!has('skip-images')) {
    try {
      await syncImages(manifest)
      /*
       * Manifesti HEMEN kaydet.
       *
       * Eskiden yalnızca tur sonunda kaydediliyordu: dosya aşaması
       * çöktüğünde resimler depoya yazılmış ama manifeste işlenmemiş
       * oluyordu ve sonraki tur hepsini baştan indiriyordu. Sahada 400
       * resim böyle iki kez indirildi.
       */
      if (!DRY_RUN) await saveManifest(manifest)
    } catch (e) {
      // Resim aşaması patlarsa dosya aşaması yine de çalışsın.
      log('resim aşaması hata verdi: ' + e.message)
    }
  }
  if (has('only-images')) {
    if (!DRY_RUN) await saveManifest(manifest)
    return
  }

  log('\n── mod dosyaları ──')

  // Kaynakta olmayanları işaretle — ama SİLME.
  const srcSet = new Set(srcFiles)
  let gone = 0
  for (const [path, rec] of Object.entries(known)) {
    if (!srcSet.has(path) && !rec.gone_from_source) {
      rec.gone_from_source = true
      rec.gone_seen_at = new Date().toISOString()
      gone++
    }
  }
  if (gone) log(`${gone} dosya kaynaktan kalkmış — arşivde bırakıldı\n`)

  /*
   * Sınır yükseldiyse eski "çok büyük" kayıtlarını unut.
   *
   * Sınır 25 MB'tan 36 MB'a çıkarıldığında, daha önce atlanmış ama artık
   * sığan dosyalar manifeste takılı kalıyordu ve bir daha hiç denenmiyordu.
   */
  let revived = 0
  for (const [path, rec] of Object.entries(known)) {
    if (rec.too_large && (rec.size || 0) <= MAX_FILE_BYTES) {
      delete known[path]
      revived++
    }
  }
  if (revived) log(`${revived} dosya yeni sınıra sığıyor, tekrar denenecek`)

  const missing = srcFiles.filter((p) => !known[p])
  log(`kaynak: ${srcFiles.length} dosya | arşiv: ${Object.keys(known).length} | eksik: ${missing.length}\n`)

  if (!missing.length) {
    log('arşiv güncel.')
    if (gone && !DRY_RUN) await saveManifest(manifest)
    process.exit(2) // döngüyü bitirmek için: "yapacak yeni iş yok"
  }

  if (DRY_RUN) {
    log('kuru çalıştırma, ilk 10 eksik dosya:')
    missing.slice(0, 10).forEach((p) => log('  ' + p))
    return
  }

  const repo = await pickRepo(manifest)
  log(`bu turda hedef depo: ${repo}\n`)

  /*
   * Kaç dosya indireceğimizi önden kestiremiyoruz (boyutlar indeks'te yok),
   * o yüzden bütçeyi aşmamak için partiler hâlinde ilerliyoruz: her partide
   * DL_CONCURRENCY kadar dosya paralel iniyor, sonra bütçe kontrol ediliyor.
   * Sıralı indirmeye göre kabaca on kat hızlı.
   */
  const batch = []
  let bytes = 0
  let skipped = 0

  const queue = missing.slice(0, MAX_FILES * 2)   // bütçe yetmezse fazlası kullanılmaz
  for (let i = 0; i < queue.length; i += DL_CONCURRENCY) {
    if (batch.length >= MAX_FILES || bytes >= MAX_BYTES) break

    const slice = queue.slice(i, i + DL_CONCURRENCY)
    const results = await mapLimit(slice, DL_CONCURRENCY, async (path) => {
      const url = SOURCE_RAW + path.split('/').map(encodeURIComponent).join('/')
      try {
        const buf = await retry(async () => {
          const r = await fetch(url, { headers: { 'User-Agent': 'autrex-mod-mirror' } })
          if (!r.ok) throw new Error(`indirilemedi ${r.status}`)
          return Buffer.from(await r.arrayBuffer())
        })
        return { path, url, buf }
      } catch (e) {
        return { path, url, error: e.message }
      }
    })

    for (const r of results) {
      if (r.error) {
        log(`  atlandı (indirilemedi): ${r.path} — ${r.error}`)
        skipped++
        continue
      }
      if (r.buf.length > MAX_FILE_BYTES) {
        // GitHub 100 MB üstünü reddediyor. Manifeste "çok büyük" diye
        // yazıyoruz ki her turda tekrar indirmeye çalışmayalım.
        log(`  atlandı (çok büyük, ${mb(r.buf.length)}): ${r.path}`)
        known[r.path] = {
          size: r.buf.length,
          too_large: true,
          source_url: r.url,
          first_seen: new Date().toISOString(),
        }
        skipped++
        continue
      }
      batch.push({ path: r.path, buffer: r.buf })
      bytes += r.buf.length
    }
    log(`  indirildi: ${batch.length} dosya / ${mb(bytes)}`)
  }

  if (!batch.length) {
    log('\nbu turda yüklenecek dosya kalmadı.')
    await saveManifest(manifest)
    process.exit(skipped ? 0 : 2)
  }

  log(`\n${batch.length} dosya / ${mb(bytes)} yükleniyor → ${repo}`)

  const res = await commitFiles(
    repo,
    batch.map((b) => ({ path: b.path, contentBase64: b.buffer.toString('base64') })),
    `arşiv: ${batch.length} yeni mod`,
  )
  log(`commit: ${res.sha?.slice(0, 8)}`)

  /*
   * Yüklenemeyen dosyalar manifeste `too_large` yazılıyor: boyut
   * eşiğini geçtikleri için değil, API onları kabul etmediği için.
   * Böylece her turda tekrar indirilmiyorlar ve site bu modlar için
   * kaynağın adresine düşüyor.
   */
  const failed = new Set(res.rejected || [])
  const now = new Date().toISOString()
  for (const b of batch) {
    if (failed.has(b.path)) {
      known[b.path] = {
        size: b.buffer.length,
        too_large: true,
        source_url: SOURCE_RAW + b.path.split('/').map(encodeURIComponent).join('/'),
        first_seen: now,
      }
      continue
    }
    known[b.path] = {
      repo,
      path: b.path,
      size: b.buffer.length,
      first_seen: now,
      gone_from_source: false,
      raw_url: `https://raw.githubusercontent.com/${OWNER}/${repo}/${BRANCH}/${b.path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`,
    }
  }
  manifest.repo_bytes[repo] = (manifest.repo_bytes[repo] || 0) + bytes

  await saveManifest(manifest)
  log(`\nkalan: ${missing.length - batch.length - skipped} dosya`)
}

async function saveManifest(manifest) {
  manifest.updated_at = new Date().toISOString()
  const json = JSON.stringify(manifest, null, 1)
  await commitFiles(
    MANIFEST_REPO,
    [{ path: MANIFEST_PATH, contentBase64: Buffer.from(json, 'utf8').toString('base64') }],
    `manifest: ${Object.keys(manifest.files).length} kayıt`,
  )
  log(`manifest güncellendi (${Object.keys(manifest.files).length} kayıt)`)
}

main().catch((e) => {
  console.error('\nHATA:', e.message)
  process.exit(1)
})
