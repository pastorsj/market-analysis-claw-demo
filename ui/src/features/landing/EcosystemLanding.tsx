// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Logo } from '@/adapters/ui'
import type { PackQuestion } from '@/adapters/api/pack-client'
import styles from './ecosystem-landing.module.css'

interface EcosystemLandingProps {
  /** Featured questions of the active data pack; each opens the research view */
  featuredQuestions: PackQuestion[]
  /** The data pack's disclaimer, shown under the introduction */
  disclaimer: string | null
}

const NvidiaMark = ({ size = 'medium' }: { size?: 'small' | 'medium' }): ReactNode => (
  <span
    className={`${styles.nvidiaMark} ${size === 'small' ? styles.nvidiaMarkSmall : ''}`}
    data-brand="NVIDIA"
    aria-hidden="true"
  >
    <Logo kind="logo-only" size="small" />
  </span>
)

/** A technology chip; NVIDIA technologies carry the NVIDIA mark, others are text only. */
const Technology = ({ children, nvidia = false }: { children: ReactNode; nvidia?: boolean }) => (
  <span className={styles.technology}>
    {nvidia && <NvidiaMark size="small" />}
    <strong>{children}</strong>
  </span>
)

export const EcosystemLanding = ({
  featuredQuestions,
  disclaimer,
}: EcosystemLandingProps): ReactNode => (
  <main className={styles.page}>
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <NvidiaMark />
          <span>NVIDIA</span>
        </div>
        <div className={styles.context}>
          <span className={styles.statusDot} aria-hidden="true" />
          Architecture overview · Market analysis
        </div>
      </header>

      <div className={styles.content}>
        <section className={styles.intro} aria-labelledby="ecosystem-title">
          <div>
            <p className={styles.eyebrow}>One agent · NVIDIA AI models · GPU acceleration</p>
            <h1 id="ecosystem-title">From market question to grounded decision.</h1>
          </div>
          <div>
            <p className={styles.introCopy}>
              A connected intelligence stack for structured data, unstructured public knowledge, and
              accelerated market analysis.
            </p>
            {disclaimer && <p className={styles.disclaimer}>{disclaimer}</p>}
          </div>
        </section>

        <section
          className={styles.architecture}
          aria-label="Market analysis technology architecture"
        >
          <article
            className={`${styles.node} ${styles.terminal} ${styles.question}`}
            data-testid="ecosystem-node"
          >
            <span className={styles.terminalIcon} aria-hidden="true">
              ?
            </span>
            <p className={styles.nodeKicker}>Natural language</p>
            <h2>Market question</h2>
            <p className={styles.nodeNote}>Ask what happened, why, and what may happen next.</p>
          </article>

          <article className={`${styles.node} ${styles.hermes}`} data-testid="ecosystem-node">
            <div className={styles.hermesHeader}>
              <div>
                <p className={styles.nodeKicker}>Nous Research</p>
                <h2>Hermes Agent</h2>
              </div>
            </div>
            <div className={styles.agentSteps} aria-label="Hermes responsibilities">
              <span>Plan</span>
              <span>Call tools</span>
              <span>Synthesize</span>
            </div>
            <div className={styles.inference}>
              <NvidiaMark size="small" />
              <span>
                <strong>NVIDIA Inference API</strong>
                <br />
                Model execution
              </span>
            </div>
          </article>

          <div className={styles.capabilities} aria-label="Agent capabilities">
            <article className={`${styles.node} ${styles.capability}`} data-testid="ecosystem-node">
              <div className={styles.capabilityHeader}>
                <span className={styles.capabilityTitle}>Structured Data</span>
                <span className={styles.role}>Retrieve · Predict</span>
              </div>
              <div className={styles.technologyRow}>
                <Technology nvidia>Auto Ontology</Technology>
                <Technology nvidia>NVIDIA Kumo</Technology>
                <Technology>DuckDB</Technology>
              </div>
            </article>

            <article className={`${styles.node} ${styles.capability}`} data-testid="ecosystem-node">
              <div className={styles.capabilityHeader}>
                <span className={styles.capabilityTitle}>Public Knowledge</span>
                <span className={styles.role}>Search</span>
              </div>
              <div className={styles.technologyGroup}>
                <p className={styles.groupLabel}>Retrieval orchestration</p>
                <div className={styles.technologyRow}>
                  <Technology>LangChain</Technology>
                  <Technology>Milvus</Technology>
                </div>
              </div>
              <div className={styles.technologyGroup}>
                <p className={styles.groupLabel}>
                  <NvidiaMark size="small" />
                  NVIDIA AI models
                </p>
                <div className={styles.technologyRow}>
                  <Technology>Nemotron Embed</Technology>
                  <Technology>Nemotron Rerank</Technology>
                </div>
              </div>
            </article>

            <article className={`${styles.node} ${styles.capability}`} data-testid="ecosystem-node">
              <div className={styles.capabilityHeader}>
                <span className={styles.capabilityTitle}>
                  <NvidiaMark size="small" />
                  Market Analytics
                </span>
                <span className={styles.role}>Analyze</span>
              </div>
              <div className={styles.technologyRow}>
                <Technology>cuDF</Technology>
                <Technology>cuGraph</Technology>
              </div>
            </article>
          </div>

          <article
            className={`${styles.node} ${styles.terminal} ${styles.answer}`}
            data-testid="ecosystem-node"
          >
            <span className={styles.terminalIcon} aria-hidden="true">
              ✦
            </span>
            <p className={styles.nodeKicker}>Inspectable output</p>
            <h2>Grounded decision</h2>
            <ul className={styles.answerList}>
              <li>Cited answers</li>
              <li>Predictions</li>
              <li>GPU analysis</li>
              <li>Replayable evidence</li>
            </ul>
          </article>

          <div className={styles.gpuFoundation} aria-label="NVIDIA GPU foundation">
            <div className={styles.gpuIdentity}>
              <NvidiaMark />
              <span>
                <strong>NVIDIA GPU foundation</strong>
                <br />
                Accelerated compute across the intelligence stack
              </span>
            </div>
            <div className={styles.gpuScope} aria-label="Accelerated workloads">
              <span>Model inference</span>
              <span>Tabular analytics</span>
              <span>Graph analytics</span>
            </div>
          </div>
        </section>

        <section className={styles.observability} aria-label="Observability flow">
          <strong>Observable by design</strong>
          <span className={styles.observabilityItem}>
            <NvidiaMark size="small" />
            NeMo Relay
          </span>
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
          <span className={styles.observabilityItem}>OpenTelemetry</span>
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
          <span className={styles.observabilityItem}>Phoenix</span>
        </section>

        {featuredQuestions.length > 0 && (
          <section className={styles.featured} aria-labelledby="featured-title">
            <h2 id="featured-title" className={styles.featuredTitle}>
              Featured questions
            </h2>
            <ul className={styles.featuredList}>
              {featuredQuestions.map((question) => (
                <li key={question.id}>
                  <Link
                    className={styles.featuredQuestion}
                    href={`/research?${new URLSearchParams({ question: question.id })}`}
                  >
                    <strong>{question.label}</strong>
                    <span>{question.question}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className={styles.footer}>
          <div className={styles.application} aria-label="Application technology">
            <strong>Application</strong>
            <span>React</span>
            <span>Next.js</span>
            <span>FastAPI</span>
          </div>
          <Link className={styles.enterLink} href="/research">
            Enter market analysis <span aria-hidden="true">→</span>
          </Link>
        </footer>
      </div>
    </div>
  </main>
)
