-- Schema-per-service on one PostgreSQL instance (spec §4.4).
-- Services never touch each other's schema (spec §0.5 rule 1).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS course;
CREATE SCHEMA IF NOT EXISTS enrollment;
CREATE SCHEMA IF NOT EXISTS outcomes;
CREATE SCHEMA IF NOT EXISTS financial;
CREATE SCHEMA IF NOT EXISTS quality;
CREATE SCHEMA IF NOT EXISTS notification;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
