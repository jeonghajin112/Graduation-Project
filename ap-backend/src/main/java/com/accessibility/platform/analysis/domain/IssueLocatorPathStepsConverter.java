package com.accessibility.platform.analysis.domain;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

import java.util.ArrayList;
import java.util.List;

@Converter
public class IssueLocatorPathStepsConverter implements AttributeConverter<List<IssueLocatorPathStep>, String> {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final TypeReference<List<IssueLocatorPathStep>> PATH_STEPS_TYPE = new TypeReference<>() {
    };

    @Override
    public String convertToDatabaseColumn(List<IssueLocatorPathStep> attribute) {
        if (attribute == null) {
            return null;
        }
        try {
            return OBJECT_MAPPER.writeValueAsString(attribute);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Failed to serialize issue locator path steps", e);
        }
    }

    @Override
    public List<IssueLocatorPathStep> convertToEntityAttribute(String dbData) {
        if (dbData == null || dbData.isBlank()) {
            return new ArrayList<>();
        }
        try {
            return new ArrayList<>(OBJECT_MAPPER.readValue(dbData, PATH_STEPS_TYPE));
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Failed to deserialize issue locator path steps", e);
        }
    }
}
