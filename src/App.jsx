import { useState, useRef, useCallback, useEffect } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

// ═══════════════════════════════════════════════════════════
// SEARCH ENGINE CORE
// ═══════════════════════════════════════════════════════════

// Stop words — common words that don't help with search relevance
const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","is","it","as","be","was","were","been","are","am","do",
  "did","does","has","had","have","he","she","they","we","you","i","my",
  "his","her","its","our","your","their","this","that","these","those",
  "not","no","so","if","then","than","when","what","which","who","how",
  "all","each","every","both","few","more","most","other","some","such",
  "only","own","same","will","can","just","should","now",
]);

/**
 * Tokenize text into an array of lowercase words.
 * Strips punctuation, filters stop words and very short tokens.
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Build an inverted index from a set of documents.
 *
 * Structure:
 *   index[term] = { docFreq: N, postings: { docId: termFreq, ... } }
 *
 * Also stores per-document token counts for TF normalization.
 */
function buildIndex(documents) {
  const index = Object.create(null);
  const docLengths = Object.create(null);

  documents.forEach((doc) => {
    const tokens = tokenize(doc.text);
    docLengths[doc.id] = tokens.length;

    // Count term frequencies in this document
    const freqs = Object.create(null);
    tokens.forEach((t) => {
      freqs[t] = (freqs[t] || 0) + 1;
    });

    // Update inverted index
    Object.keys(freqs).forEach((term) => {
      if (!index[term]) {
        index[term] = { docFreq: 0, postings: Object.create(null) };
      }
      index[term].docFreq++;
      index[term].postings[doc.id] = freqs[term];
    });
  });

  return { index, docLengths, totalDocs: documents.length };
}

/**
 * Search the index using TF-IDF scoring.
 *
 * TF  = (term frequency in doc) / (total tokens in doc)
 * IDF = log(total docs / docs containing term)
 * Score = sum of TF * IDF for each query term
 */
function search(query, indexData, documents) {
  const { index, docLengths, totalDocs } = indexData;
  const queryTerms = tokenize(query);

  if (queryTerms.length === 0) return [];

  const scores = {};

  queryTerms.forEach((term) => {
    const entry = index[term];
    if (!entry) return;

    const idf = Math.log(totalDocs / entry.docFreq);

    Object.entries(entry.postings).forEach(([docId, tf]) => {
      const normalizedTf = tf / (docLengths[docId] || 1);
      scores[docId] = (scores[docId] || 0) + normalizedTf * idf;
    });
  });

  // Sort by score descending
  const results = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([docId, score]) => {
      const doc = documents.find((d) => d.id === docId);
      return {
        ...doc,
        score,
        snippet: extractSnippet(doc.text, queryTerms),
        matchedTerms: queryTerms.filter((t) => index[t]?.postings[docId]),
      };
    });

  return results;
}

/**
 * Extract a text snippet around the first occurrence of a query term,
 * with surrounding context.
 */
function extractSnippet(text, queryTerms, contextChars = 120) {
  const lower = text.toLowerCase();
  let bestPos = -1;
  let bestTerm = "";

  for (const term of queryTerms) {
    const pos = lower.indexOf(term);
    if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
      bestPos = pos;
      bestTerm = term;
    }
  }

  if (bestPos === -1) {
    return text.slice(0, contextChars * 2) + (text.length > contextChars * 2 ? "..." : "");
  }

  const start = Math.max(0, bestPos - contextChars);
  const end = Math.min(text.length, bestPos + bestTerm.length + contextChars);
  let snippet = text.slice(start, end).trim();

  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";

  return snippet;
}

/**
 * Highlight matched terms in a snippet by wrapping them in marks.
 * Returns an array of { text, highlight } segments.
 */
function highlightSnippet(snippet, terms) {
  if (!terms.length) return [{ text: snippet, highlight: false }];

  const regex = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  const parts = snippet.split(regex);

  return parts.map((part) => ({
    text: part,
    highlight: terms.some((t) => part.toLowerCase() === t.toLowerCase()),
  }));
}

// ═══════════════════════════════════════════════════════════
// FILE PARSING
// ═══════════════════════════════════════════════════════════

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "js", "jsx", "ts", "tsx", "py", "java",
  "c", "cpp", "h", "hpp", "cs", "rb", "go", "rs", "swift", "kt",
  "html", "css", "scss", "less", "json", "xml", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "sh", "bash", "zsh", "fish",
  "sql", "r", "m", "tex", "bib", "csv", "tsv", "log", "env",
  "gitignore", "dockerfile", "makefile",
]);

function getExtension(name) {
  const parts = name.split(".");
  if (parts.length < 2) return "";
  return parts[parts.length - 1].toLowerCase();
}

function isTextFile(name) {
  const ext = getExtension(name);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // Files without extensions are often text (README, LICENSE, Makefile)
  if (!ext && !name.includes(".")) return true;
  return false;
}

async function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsText(file);
  });
}

async function parseFile(file) {
  const ext = getExtension(file.name);

  if (isTextFile(file.name)) {
    const text = await readFileAsText(file);
    return { text, type: ext || "text" };
  }

  if (ext === "pdf") {
    // PDF parsing via pdf.js
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((item) => item.str).join(" ") + "\n";
      }
      return { text, type: "pdf" };
    } catch (e) {
      return { text: "", type: "pdf", error: "Could not parse PDF" };
    }
  }

  return { text: "", type: ext, error: "Unsupported file type" };
}

// ═══════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════

function FileTypeTag({ type }) {
  const colors = {
    pdf: "#e74c3c",
    js: "#f0db4f", jsx: "#f0db4f", ts: "#3178c6", tsx: "#3178c6",
    py: "#3776ab", java: "#b07219", c: "#555", cpp: "#555",
    md: "#519aba", markdown: "#519aba",
    html: "#e34c26", css: "#1572b6",
    json: "#a0a0a0", yaml: "#a0a0a0", yml: "#a0a0a0",
    txt: "#888", text: "#888",
    sql: "#e38c00", sh: "#89e051", bash: "#89e051",
  };
  const color = colors[type] || "#666";
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, color, background: color + "18",
      padding: "2px 7px", borderRadius: 3, textTransform: "uppercase",
      letterSpacing: "0.5px", flexShrink: 0,
    }}>
      {type}
    </span>
  );
}

function DropZone({ onFiles, fileCount }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const dragCounter = useRef(0);

  const handleDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragIn = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    setDragging(true);
  }, []);

  const handleDragOut = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;

    const files = [];
    if (e.dataTransfer.items) {
      for (let i = 0; i < e.dataTransfer.items.length; i++) {
        if (e.dataTransfer.items[i].kind === "file") {
          files.push(e.dataTransfer.items[i].getAsFile());
        }
      }
    } else {
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        files.push(e.dataTransfer.files[i]);
      }
    }
    if (files.length) onFiles(files);
  }, [onFiles]);

  return (
    <div
      onDragEnter={handleDragIn}
      onDragLeave={handleDragOut}
      onDragOver={handleDrag}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      style={{
        ...st.dropZone,
        borderColor: dragging ? "#e8a838" : "#252525",
        background: dragging ? "#e8a83808" : "#0a0a0a",
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length) onFiles(files);
          e.target.value = "";
        }}
      />
      <div style={st.dropIcon}>{fileCount > 0 ? "+" : "↓"}</div>
      <div style={st.dropText}>
        {fileCount > 0
          ? "Drop more files or click to add"
          : "Drop files here or click to browse"}
      </div>
      <div style={st.dropHint}>
        Supports txt, md, pdf, code files, and more
      </div>
    </div>
  );
}

function SearchBar({ query, onChange, resultCount, indexSize }) {
  return (
    <div style={st.searchWrap}>
      <div style={st.searchIcon}>⌕</div>
      <input
        type="text"
        placeholder={indexSize > 0 ? `Search across ${indexSize} files...` : "Index some files first..."}
        value={query}
        onChange={(e) => onChange(e.target.value)}
        disabled={indexSize === 0}
        style={st.searchInput}
      />
      {query && (
        <div style={st.resultCount}>
          {resultCount} result{resultCount !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

function ResultCard({ result, rank }) {
  const segments = highlightSnippet(result.snippet, result.matchedTerms);
  const scorePercent = Math.min(100, Math.round(result.score * 200));

  return (
    <div style={{ ...st.resultCard, animationDelay: `${rank * 40}ms` }}>
      <div style={st.resultHeader}>
        <div style={st.resultLeft}>
          <span style={st.resultRank}>#{rank + 1}</span>
          <span style={st.resultName}>{result.name}</span>
          <FileTypeTag type={result.type} />
        </div>
        <div style={st.resultScore}>
          <div style={st.scoreBar}>
            <div style={{ ...st.scoreBarFill, width: `${scorePercent}%` }} />
          </div>
          <span style={st.scoreLabel}>{result.score.toFixed(3)}</span>
        </div>
      </div>
      <div style={st.snippet}>
        {segments.map((seg, i) => (
          <span key={i} style={seg.highlight ? st.highlight : undefined}>
            {seg.text}
          </span>
        ))}
      </div>
      <div style={st.resultMeta}>
        {result.matchedTerms.length} term{result.matchedTerms.length !== 1 ? "s" : ""} matched
        · {(result.text.length / 1024).toFixed(1)}KB
        · {result.text.split(/\s+/).length.toLocaleString()} words
      </div>
    </div>
  );
}

function IndexedFilesList({ documents, onRemove, onClear }) {
  if (documents.length === 0) return null;
  return (
    <div style={st.indexedPanel}>
      <div style={st.indexedHeader}>
        <span style={st.indexedTitle}>Indexed Files ({documents.length})</span>
        <button onClick={onClear} style={st.clearBtn}>Clear All</button>
      </div>
      <div style={st.indexedList}>
        {documents.map((doc) => (
          <div key={doc.id} style={st.indexedItem}>
            <FileTypeTag type={doc.type} />
            <span style={st.indexedName}>{doc.name}</span>
            <span style={st.indexedSize}>{(doc.text.length / 1024).toFixed(1)}KB</span>
            <button onClick={() => onRemove(doc.id)} style={st.removeBtn}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stats({ indexData, documents }) {
  if (!indexData || documents.length === 0) return null;
  const termCount = Object.keys(indexData.index).length;
  const totalWords = Object.values(indexData.docLengths).reduce((a, b) => a + b, 0);
  return (
    <div style={st.statsRow}>
      <div style={st.statItem}>
        <div style={st.statNum}>{documents.length}</div>
        <div style={st.statLabel}>files</div>
      </div>
      <div style={st.statItem}>
        <div style={st.statNum}>{termCount.toLocaleString()}</div>
        <div style={st.statLabel}>unique terms</div>
      </div>
      <div style={st.statItem}>
        <div style={st.statNum}>{totalWords.toLocaleString()}</div>
        <div style={st.statLabel}>total tokens</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// LOCAL STORAGE HELPERS
// ═══════════════════════════════════════════════════════════
const STORAGE_KEY = "sift_documents";

function saveToStorage(docs) {
  try {
    // Store just the essentials: name, text, type, id
    const slim = docs.map(({ id, name, text, type, size }) => ({ id, name, text, type, size }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch (e) {
    console.warn("localStorage save failed:", e.message);
    // Likely hit the storage limit — fail silently
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const docs = JSON.parse(raw);
    if (!Array.isArray(docs)) return [];
    return docs;
  } catch (e) {
    console.warn("localStorage load failed:", e.message);
    return [];
  }
}

function clearStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // fail silently
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════
export default function App() {
  const [documents, setDocuments] = useState(() => loadFromStorage());
  const [indexData, setIndexData] = useState(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [errors, setErrors] = useState([]);

  // Rebuild index whenever documents change
  useEffect(() => {
    if (documents.length === 0) {
      setIndexData(null);
      setResults([]);
      return;
    }
    const idx = buildIndex(documents);
    setIndexData(idx);
  }, [documents]);

  // Persist documents to localStorage whenever they change
  useEffect(() => {
    saveToStorage(documents);
  }, [documents]);

  // Re-search whenever query or index changes
  useEffect(() => {
    if (!query.trim() || !indexData) {
      setResults([]);
      return;
    }
    const r = search(query, indexData, documents);
    setResults(r);
  }, [query, indexData, documents]);

  async function handleFiles(files) {
    setProcessing(true);
    setErrors([]);
    const newDocs = [];
    const newErrors = [];

    for (const file of files) {
      // Skip duplicates
      if (documents.some((d) => d.name === file.name)) {
        newErrors.push(`"${file.name}" already indexed, skipping`);
        continue;
      }

      try {
        const parsed = await parseFile(file);
        if (parsed.error) {
          newErrors.push(`${file.name}: ${parsed.error}`);
          continue;
        }
        if (!parsed.text.trim()) {
          newErrors.push(`${file.name}: No text content found`);
          continue;
        }
        newDocs.push({
          id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          text: parsed.text,
          type: parsed.type,
          size: file.size,
        });
      } catch (e) {
        newErrors.push(`${file.name}: ${e.message}`);
      }
    }

    if (newDocs.length) {
      setDocuments((prev) => [...prev, ...newDocs]);
    }
    if (newErrors.length) {
      setErrors(newErrors);
      setTimeout(() => setErrors([]), 5000);
    }
    setProcessing(false);
  }

  function removeDoc(id) {
    setDocuments((prev) => prev.filter((d) => d.id !== id));
  }

  function clearAll() {
    setDocuments([]);
    setQuery("");
    setResults([]);
    clearStorage();
  }

  return (
    <div style={st.root}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Newsreader:ital,wght@0,400;0,600;1,400&display=swap');
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        *{box-sizing:border-box;margin:0;padding:0}
        ::selection{background:#e8a83844}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:#252525;border-radius:3px}::-webkit-scrollbar-track{background:transparent}
        input:focus{outline:none;border-color:#e8a838 !important}
      `}</style>


      <header style={st.header}>
        <div style={st.headerIn}>
          <h1 style={st.title}>
            <span style={st.titleIcon}>⌕</span>
            Sift
          </h1>
          <p style={st.subtitle}>A client-side search engine</p>
        </div>
      </header>

      <div style={st.content}>
        <DropZone onFiles={handleFiles} fileCount={documents.length} />

        {processing && (
          <div style={st.processingMsg}>Indexing files...</div>
        )}

        {errors.length > 0 && (
          <div style={st.errorBox}>
            {errors.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        )}

        <Stats indexData={indexData} documents={documents} />

        <IndexedFilesList documents={documents} onRemove={removeDoc} onClear={clearAll} />

        <SearchBar
          query={query}
          onChange={setQuery}
          resultCount={results.length}
          indexSize={documents.length}
        />

        {results.length > 0 && (
          <div style={st.resultsList}>
            {results.map((r, i) => (
              <ResultCard key={r.id} result={r} rank={i} />
            ))}
          </div>
        )}

        {query && results.length === 0 && indexData && (
          <div style={st.noResults}>
            No results for "{query}" across {documents.length} files
          </div>
        )}
      </div>

      <footer style={st.footer}>
        Sift — built with inverted indexing & TF-IDF ranking · All processing happens in your browser
      </footer>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════
const st = {
  root: {
    fontFamily: "'IBM Plex Mono', monospace",
    background: "#060606",
    color: "#b0b0b0",
    minHeight: "100vh",
  },
  header: {
    padding: "32px 32px 0",
  },
  headerIn: {
    maxWidth: 820,
    margin: "0 auto",
  },
  title: {
    fontFamily: "'Newsreader', serif",
    fontSize: 32,
    fontWeight: 600,
    color: "#e8e0d0",
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  titleIcon: {
    fontSize: 28,
    color: "#e8a838",
  },
  subtitle: {
    fontSize: 12,
    color: "#555",
    marginTop: 4,
    letterSpacing: "1px",
  },
  content: {
    maxWidth: 820,
    margin: "0 auto",
    padding: "24px 32px",
  },

  // Drop zone
  dropZone: {
    border: "1.5px dashed #252525",
    borderRadius: 8,
    padding: "36px 24px",
    textAlign: "center",
    cursor: "pointer",
    transition: "all .2s",
    marginBottom: 20,
  },
  dropIcon: {
    fontSize: 28,
    color: "#e8a838",
    marginBottom: 8,
    fontWeight: 300,
  },
  dropText: {
    fontSize: 13,
    color: "#888",
    marginBottom: 4,
  },
  dropHint: {
    fontSize: 11,
    color: "#444",
  },

  // Processing / errors
  processingMsg: {
    fontSize: 12,
    color: "#e8a838",
    marginBottom: 16,
    animation: "fadeUp .3s ease both",
  },
  errorBox: {
    fontSize: 11,
    color: "#e74c3c",
    background: "#e74c3c0a",
    border: "1px solid #e74c3c22",
    borderRadius: 4,
    padding: "8px 12px",
    marginBottom: 16,
    lineHeight: 1.6,
  },

  // Stats
  statsRow: {
    display: "flex",
    gap: 24,
    marginBottom: 20,
    padding: "12px 0",
    borderBottom: "1px solid #141414",
  },
  statItem: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
  },
  statNum: {
    fontSize: 18,
    fontWeight: 600,
    color: "#e8e0d0",
    fontFamily: "'Newsreader', serif",
  },
  statLabel: {
    fontSize: 11,
    color: "#555",
  },

  // Indexed files
  indexedPanel: {
    marginBottom: 20,
    animation: "fadeUp .4s ease both",
  },
  indexedHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  indexedTitle: {
    fontSize: 12,
    color: "#666",
    fontWeight: 500,
  },
  clearBtn: {
    fontSize: 11,
    color: "#e74c3c",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  indexedList: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
  },
  indexedItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "#0c0c0c",
    border: "1px solid #1a1a1a",
    borderRadius: 4,
    padding: "4px 8px",
    animation: "fadeUp .3s ease both",
  },
  indexedName: {
    fontSize: 11,
    color: "#999",
    maxWidth: 150,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  indexedSize: {
    fontSize: 10,
    color: "#444",
  },
  removeBtn: {
    fontSize: 14,
    color: "#555",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: "0 2px",
    lineHeight: 1,
    fontFamily: "'IBM Plex Mono', monospace",
  },

  // Search
  searchWrap: {
    position: "relative",
    marginBottom: 20,
  },
  searchIcon: {
    position: "absolute",
    left: 14,
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: 18,
    color: "#444",
    pointerEvents: "none",
  },
  searchInput: {
    width: "100%",
    background: "#0a0a0a",
    border: "1px solid #1a1a1a",
    borderRadius: 6,
    padding: "14px 14px 14px 42px",
    color: "#ddd",
    fontSize: 14,
    fontFamily: "'IBM Plex Mono', monospace",
    transition: "border-color .2s",
  },
  resultCount: {
    position: "absolute",
    right: 14,
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: 11,
    color: "#555",
  },

  // Results
  resultsList: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  resultCard: {
    background: "#0a0a0a",
    border: "1px solid #161616",
    borderRadius: 6,
    padding: 16,
    animation: "fadeUp .4s ease both",
    transition: "border-color .15s",
  },
  resultHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
    gap: 12,
  },
  resultLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
  },
  resultRank: {
    fontSize: 11,
    color: "#e8a838",
    fontWeight: 600,
    flexShrink: 0,
  },
  resultName: {
    fontSize: 13,
    color: "#e8e0d0",
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  resultScore: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  scoreBar: {
    width: 60,
    height: 4,
    background: "#1a1a1a",
    borderRadius: 2,
    overflow: "hidden",
  },
  scoreBarFill: {
    height: "100%",
    background: "linear-gradient(90deg, #e8a838, #e8a83866)",
    borderRadius: 2,
    transition: "width .4s ease",
  },
  scoreLabel: {
    fontSize: 10,
    color: "#555",
    fontVariantNumeric: "tabular-nums",
  },
  snippet: {
    fontSize: 12,
    color: "#888",
    lineHeight: 1.7,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  highlight: {
    color: "#e8a838",
    fontWeight: 600,
    background: "#e8a83815",
    padding: "1px 3px",
    borderRadius: 2,
  },
  resultMeta: {
    fontSize: 10,
    color: "#444",
    marginTop: 8,
  },
  noResults: {
    textAlign: "center",
    fontSize: 13,
    color: "#555",
    padding: "32px 0",
  },

  // Footer
  footer: {
    maxWidth: 820,
    margin: "32px auto 0",
    padding: "16px 32px",
    borderTop: "1px solid #111",
    fontSize: 10,
    color: "#333",
    textAlign: "center",
  },
};