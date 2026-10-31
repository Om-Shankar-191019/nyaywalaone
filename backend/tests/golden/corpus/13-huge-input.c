#include <stdio.h>

/* Reads to EOF instead of exactly two integers, so it survives extra input. */
int main(void) {
    long total = 0;
    long value = 0;
    while (scanf("%ld", &value) == 1) {
        total += value;
    }
    printf("%ld\n", total);
    return 0;
}
