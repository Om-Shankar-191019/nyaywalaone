#include <stdio.h>

/* Prints the sum together with a UTF-8 label: "résumé ✓ 日本語". */
int main(void) {
    int a = 0, b = 0;
    if (scanf("%d %d", &a, &b) != 2) {
        return 1;
    }
    printf("%d\n", a + b);
    fprintf(stderr, "résumé ✓ 日本語\n");
    return 0;
}
