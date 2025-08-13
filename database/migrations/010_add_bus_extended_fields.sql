-- Migration 010: Add extended fields to buses table
-- Run this in Supabase SQL Editor

-- Add new columns to buses table
ALTER TABLE public.buses 
ADD COLUMN IF NOT EXISTS plate_number TEXT,
ADD COLUMN IF NOT EXISTS engine_type TEXT DEFAULT 'petrol' CHECK (engine_type IN ('petrol', 'diesel', 'gas', 'hybrid', 'electric')),
ADD COLUMN IF NOT EXISTS width DECIMAL(5, 2),
ADD COLUMN IF NOT EXISTS length DECIMAL(5, 2),
ADD COLUMN IF NOT EXISTS consumption_per_100km DECIMAL(5, 1);

-- Add comments for documentation
COMMENT ON COLUMN public.buses.plate_number IS 'Vehicle license plate number';
COMMENT ON COLUMN public.buses.engine_type IS 'Type of engine: petrol, diesel, gas (CNG/LPG), hybrid, electric';
COMMENT ON COLUMN public.buses.width IS 'Bus width in meters';
COMMENT ON COLUMN public.buses.length IS 'Bus length in meters';
COMMENT ON COLUMN public.buses.consumption_per_100km IS 'Fuel/energy consumption per 100 kilometers in liters or kWh';