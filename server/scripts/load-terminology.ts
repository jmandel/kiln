#!/usr/bin/env bun
/**
 * Clean terminology loader for FHIR code systems
 * Creates a fresh database with individual designation rows for better search matching
 */

import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "fs";

// Configuration
const DB_PATH = process.env.TERMINOLOGY_DB_PATH || "./db/terminology.sqlite";
const VOCAB_DIR = "./large-vocabularies";

// Known system URLs
const SYSTEM_URLS = {
  loinc: "http://loinc.org",
  snomed: "http://snomed.info/sct",
  rxnorm: "http://www.nlm.nih.gov/research/umls/rxnorm",
} as const;

// External sources
const FHIR_R4_VALUESETS = "https://hl7.org/fhir/R4/valuesets.json";
const UTG_IG = "https://build.fhir.org/ig/HL7/UTG/full-ig.zip";

interface CodeSystemHeader {
  resourceType: "CodeSystem";
  url: string;
  version?: string;
  name?: string;
  title?: string;
  date?: string;
}

interface Concept {
  code: string;
  display?: string;
  designation?: Array<{ value?: string; use?: { code?: string } }>;
}

class TerminologyLoader {
  private db: Database;

  constructor(dbPath: string) {
    // Remove existing database
    if (existsSync(dbPath)) {
      console.log(`🗑️  Removing existing database: ${dbPath}`);
      unlinkSync(dbPath);
    }

    console.log(`📊 Creating fresh database: ${dbPath}`);
    this.db = new Database(dbPath);
    this.initDatabase();
  }

  private initDatabase() {
    // Performance settings
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA temp_store=MEMORY;
      PRAGMA cache_size=10000;
    `);

    // Create schema with separate designations table
    this.db.exec(`
      CREATE TABLE code_systems (
        id INTEGER PRIMARY KEY,
        system TEXT NOT NULL UNIQUE,
        version TEXT,
        name TEXT,
        title TEXT,
        date TEXT,
        concept_count INTEGER DEFAULT 0,
        source TEXT,
        loaded_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE concepts (
        id INTEGER PRIMARY KEY,
        system TEXT NOT NULL,
        code TEXT NOT NULL,
        display TEXT,
        UNIQUE(system, code)
      );

      CREATE TABLE designations (
        id INTEGER PRIMARY KEY,
        concept_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        use_code TEXT,
        FOREIGN KEY (concept_id) REFERENCES concepts(id)
      );

      CREATE INDEX idx_concepts_system ON concepts(system);
      CREATE INDEX idx_concepts_code ON concepts(code);
      CREATE INDEX idx_designations_concept ON designations(concept_id);
    `);
  }

  /**
   * Load NDJSON.gz file
   */
  async loadNDJSON(filePath: string) {
    console.log(`📂 Loading: ${filePath}`);
    
    const file = Bun.file(filePath);
    const compressed = await file.arrayBuffer();
    const decompressed = Bun.gunzipSync(new Uint8Array(compressed));
    const text = new TextDecoder().decode(decompressed);
    const lines = text.trim().split('\n');

    if (lines.length === 0) {
      throw new Error(`Empty file: ${filePath}`);
    }

    // First line is the CodeSystem resource
    const codeSystem = JSON.parse(lines[0]) as CodeSystemHeader;
    const system = codeSystem.url;
    
    if (!system) {
      throw new Error(`No system URL in: ${filePath}`);
    }

    console.log(`🔍 System: ${system} (version: ${codeSystem.version || 'unknown'})`);
    
    // Prepare statements
    const insertConcept = this.db.prepare(`
      INSERT OR REPLACE INTO concepts (system, code, display)
      VALUES (?, ?, ?)
    `);

    const insertDesignation = this.db.prepare(`
      INSERT INTO designations (concept_id, label, use_code)
      VALUES (?, ?, ?)
    `);

    const getConceptId = this.db.prepare(`
      SELECT id FROM concepts WHERE system = ? AND code = ?
    `);

    // Process concepts in batches
    const BATCH_SIZE = 10000;
    let processedCount = 0;

    const transaction = this.db.transaction((batch: string[]) => {
      for (const line of batch) {
        if (!line.trim()) continue;
        
        try {
          const concept = JSON.parse(line) as Concept;
          if (!concept.code) continue;

          // Insert concept
          insertConcept.run(
            system,
            concept.code,
            concept.display || ''
          );
          
          // Get concept ID
          const conceptRow = getConceptId.get(system, concept.code) as { id: number };
          if (!conceptRow) continue;

          // Insert display as a designation
          if (concept.display) {
            insertDesignation.run(conceptRow.id, concept.display, null);
          }

          // Insert all other designations
          for (const designation of concept.designation || []) {
            if (designation.value && designation.value !== concept.display) {
              insertDesignation.run(
                conceptRow.id,
                designation.value,
                designation.use?.code || null
              );
            }
          }
          
          processedCount++;
        } catch (e) {
          // Skip invalid lines silently
        }
      }
    });

    // Process in batches (skip first line which is CodeSystem)
    for (let i = 1; i < lines.length; i += BATCH_SIZE) {
      const batch = lines.slice(i, Math.min(i + BATCH_SIZE, lines.length));
      transaction(batch);
      if (processedCount % 50000 === 0) {
        console.log(`  ✓ Processed ${processedCount} concepts...`);
      }
    }

    // Update code system record
    this.db.prepare(`
      INSERT OR REPLACE INTO code_systems (system, version, name, title, date, concept_count, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      system,
      codeSystem.version || null,
      codeSystem.name || null,
      codeSystem.title || null,
      codeSystem.date || null,
      processedCount,
      filePath
    );

    console.log(`✅ Loaded ${processedCount} concepts from ${system}`);
    return processedCount;
  }

  /**
   * Find and load the latest version of each vocabulary
   */
  async loadVocabularies() {
    const files = {
      loinc: [] as string[],
      snomed: [] as string[],
      rxnorm: [] as string[]
    };

    // Scan for vocabulary files
    const glob = new Bun.Glob("CodeSystem-*.ndjson.gz");
    for await (const path of glob.scan({ cwd: VOCAB_DIR })) {
      const fullPath = `${VOCAB_DIR}/${path}`;
      
      if (path.includes('loinc') && !path.match(/-[a-z]{2}-[A-Z]{2}\./)) {
        files.loinc.push(fullPath);
      } else if (path.includes('snomed')) {
        files.snomed.push(fullPath);
      } else if (path.includes('rxnorm')) {
        files.rxnorm.push(fullPath);
      }
    }

    let totalLoaded = 0;

    // Load latest version of each (sorted by filename which includes date/version)
    for (const [vocab, paths] of Object.entries(files)) {
      if (paths.length === 0) {
        console.log(`⚠️  No ${vocab} files found in ${VOCAB_DIR}`);
        continue;
      }
      
      // Sort to get latest (assumes version/date in filename)
      paths.sort().reverse();
      const latest = paths[0];
      console.log(`📦 Loading latest ${vocab}: ${latest}`);
      totalLoaded += await this.loadNDJSON(latest);
    }

    return totalLoaded;
  }

  /**
   * Load FHIR R4 valuesets
   */
  async loadFHIRValuesets() {
    console.log(`📥 Downloading FHIR R4 valuesets from ${FHIR_R4_VALUESETS}...`);
    
    const response = await fetch(FHIR_R4_VALUESETS);
    if (!response.ok) {
      throw new Error(`Failed to download FHIR valuesets: ${response.statusText}`);
    }

    const bundle = await response.json();
    if (bundle.resourceType !== 'Bundle') {
      throw new Error(`Invalid bundle format`);
    }

    let loadedSystems = 0;
    let loadedConcepts = 0;

    const insertConcept = this.db.prepare(`
      INSERT OR REPLACE INTO concepts (system, code, display)
      VALUES (?, ?, ?)
    `);

    const insertDesignation = this.db.prepare(`
      INSERT INTO designations (concept_id, label, use_code)
      VALUES (?, ?, ?)
    `);

    const getConceptId = this.db.prepare(`
      SELECT id FROM concepts WHERE system = ? AND code = ?
    `);

    for (const entry of bundle.entry || []) {
      const resource = entry.resource;
      if (resource?.resourceType !== 'CodeSystem') continue;

      const system = resource.url;
      if (!system) continue;

      // Skip if it's one of the big vocabularies we already loaded
      if (Object.values(SYSTEM_URLS).includes(system)) continue;

      const concepts = resource.concept || [];
      if (concepts.length === 0) continue;

      const transaction = this.db.transaction(() => {
        for (const concept of concepts) {
          if (!concept.code) continue;
          
          insertConcept.run(
            system,
            concept.code,
            concept.display || ''
          );

          // Get concept ID and insert display as designation
          const conceptRow = getConceptId.get(system, concept.code) as { id: number };
          if (conceptRow && concept.display) {
            insertDesignation.run(conceptRow.id, concept.display, null);
          }

          loadedConcepts++;
        }
      });
      transaction();

      // Update code system record
      this.db.prepare(`
        INSERT OR REPLACE INTO code_systems (system, version, name, title, concept_count, source)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        system,
        resource.version || null,
        resource.name || null,
        resource.title || null,
        concepts.length,
        'FHIR R4 Valuesets'
      );

      loadedSystems++;
    }

    console.log(`✅ Loaded ${loadedSystems} FHIR code systems with ${loadedConcepts} concepts`);
    return loadedConcepts;
  }

  /**
   * Load UTG (Unified Terminology Governance) codesystems
   */
  async loadUTG() {
    console.log(`📥 Downloading UTG from ${UTG_IG}...`);
    
    const tempDir = `/tmp/utg-${Date.now()}`;
    const zipPath = `${tempDir}/utg.zip`;
    
    // Create temp directory
    await Bun.spawn(['mkdir', '-p', tempDir]);

    // Download
    const response = await fetch(UTG_IG);
    if (!response.ok) {
      throw new Error(`Failed to download UTG: ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    await Bun.write(zipPath, buffer);
    console.log(`💾 Downloaded UTG (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);

    // Extract
    const proc = Bun.spawn(['unzip', '-q', '-o', zipPath, '-d', tempDir], {
      stdout: 'pipe',
      stderr: 'pipe'
    });
    
    await proc.exited;
    
    // Find and load CodeSystem files
    const csGlob = new Bun.Glob("**/CodeSystem-*.json");
    let loadedSystems = 0;
    let loadedConcepts = 0;

    const insertConcept = this.db.prepare(`
      INSERT OR REPLACE INTO concepts (system, code, display)
      VALUES (?, ?, ?)
    `);

    const insertDesignation = this.db.prepare(`
      INSERT INTO designations (concept_id, label, use_code)
      VALUES (?, ?, ?)
    `);

    const getConceptId = this.db.prepare(`
      SELECT id FROM concepts WHERE system = ? AND code = ?
    `);

    for await (const path of csGlob.scan({ cwd: tempDir })) {
      const fullPath = `${tempDir}/${path}`;
      
      try {
        const file = Bun.file(fullPath);
        const codeSystem = await file.json();
        
        if (codeSystem.resourceType !== 'CodeSystem') continue;
        
        const system = codeSystem.url;
        if (!system) continue;

        // Skip if already loaded
        if (Object.values(SYSTEM_URLS).includes(system)) continue;

        const concepts = codeSystem.concept || [];
        if (concepts.length === 0) continue;

        // Process concepts recursively (UTG can have hierarchical concepts)
        const processConceptHierarchy = (concepts: any[]) => {
          for (const concept of concepts) {
            if (!concept.code) continue;
            
            insertConcept.run(
              system,
              concept.code,
              concept.display || ''
            );

            // Get concept ID and insert display as designation
            const conceptRow = getConceptId.get(system, concept.code) as { id: number };
            if (conceptRow && concept.display) {
              insertDesignation.run(conceptRow.id, concept.display, null);
            }

            loadedConcepts++;

            // Process child concepts
            if (concept.concept) {
              processConceptHierarchy(concept.concept);
            }
          }
        };

        const transaction = this.db.transaction(() => {
          processConceptHierarchy(concepts);
        });
        transaction();

        // Update code system record
        this.db.prepare(`
          INSERT OR REPLACE INTO code_systems (system, version, name, title, concept_count, source)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          system,
          codeSystem.version || null,
          codeSystem.name || null,
          codeSystem.title || null,
          concepts.length,
          'UTG'
        );

        loadedSystems++;
      } catch (e) {
        // Skip files that fail to load
      }
    }

    // Clean up temp directory
    await Bun.spawn(['rm', '-rf', tempDir]).exited;

    console.log(`✅ Loaded ${loadedSystems} UTG code systems with ${loadedConcepts} concepts`);
    return loadedConcepts;
  }

  /**
   * Optimize the database after loading
   */
  optimize() {
    console.log(`🔧 Optimizing database...`);
    
    // Create FTS table for designations
    console.log(`  • Creating FTS index for designations...`);
    this.db.exec(`
      CREATE VIRTUAL TABLE designations_fts USING fts5(
        label,
        content='designations',
        content_rowid='id'
      );
    `);
    
    // Populate FTS from designations table
    console.log(`  • Building FTS index...`);
    this.db.exec("INSERT INTO designations_fts(rowid, label) SELECT id, label FROM designations");
    
    // Optimize FTS index
    this.db.exec("INSERT INTO designations_fts(designations_fts) VALUES('optimize')");
    
    // Add triggers for future updates
    this.db.exec(`
      CREATE TRIGGER designations_ai AFTER INSERT ON designations BEGIN
        INSERT INTO designations_fts(rowid, label)
        VALUES (new.id, new.label);
      END;

      CREATE TRIGGER designations_au AFTER UPDATE ON designations BEGIN
        DELETE FROM designations_fts WHERE rowid = old.id;
        INSERT INTO designations_fts(rowid, label)
        VALUES (new.id, new.label);
      END;

      CREATE TRIGGER designations_ad AFTER DELETE ON designations BEGIN
        DELETE FROM designations_fts WHERE rowid = old.id;
      END;
    `);
    
    // Analyze for query planning
    this.db.exec("ANALYZE");
  }

  /**
   * Print summary statistics
   */
  printSummary() {
    const systems = this.db.prepare("SELECT COUNT(*) as count FROM code_systems").get() as { count: number };
    const concepts = this.db.prepare("SELECT COUNT(*) as count FROM concepts").get() as { count: number };
    const designations = this.db.prepare("SELECT COUNT(*) as count FROM designations").get() as { count: number };
    
    console.log(`
📊 Summary:
  • Code Systems: ${systems.count}
  • Total Concepts: ${concepts.count.toLocaleString()}
  • Total Designations: ${designations.count.toLocaleString()}
  • Database: ${DB_PATH}
    `);

    // Show top systems by concept count
    const topSystems = this.db.prepare(`
      SELECT system, concept_count, version 
      FROM code_systems 
      ORDER BY concept_count DESC 
      LIMIT 10
    `).all() as Array<{ system: string; concept_count: number; version: string }>;

    console.log(`🏆 Top Code Systems:`);
    for (const sys of topSystems) {
      console.log(`  • ${sys.system}: ${sys.concept_count.toLocaleString()} concepts (v${sys.version || 'unknown'})`);
    }
  }

  close() {
    this.db.close();
  }
}

// Main execution
async function main() {
  console.log(`
🚀 FHIR Terminology Loader
==========================
`);

  const loader = new TerminologyLoader(DB_PATH);

  try {
    // 1. Load large vocabularies from NDJSON
    console.log(`\n📦 Step 1: Loading large vocabularies...`);
    const vocabCount = await loader.loadVocabularies();

    // 2. Load FHIR R4 valuesets
    console.log(`\n📦 Step 2: Loading FHIR R4 valuesets...`);
    const fhirCount = await loader.loadFHIRValuesets();

    // 3. Load UTG codesystems
    console.log(`\n📦 Step 3: Loading UTG codesystems...`);
    const utgCount = await loader.loadUTG();

    // 4. Optimize
    console.log(`\n🔧 Step 4: Optimizing database...`);
    loader.optimize();

    // 5. Summary
    loader.printSummary();

  } catch (error) {
    console.error(`\n❌ Error: ${error}`);
    process.exit(1);
  } finally {
    loader.close();
  }

  console.log(`\n✅ Complete!`);
}

// Run if executed directly
if (import.meta.main) {
  main();
}
